// Owns everything viewer.js's WebGL2 code used to do: GL context + shader
// setup, layer-batched vertex buffers, camera (pan/zoom) state, input
// handling, .lyp color parsing, and scale-bar text/width. JS never touches
// per-polygon data directly.
//
// parseGdsToLayers() (parse + flatten + triangulate, no GL/DOM) runs inside
// a Worker instantiated from this same module (see wasm-worker.js) so large
// files don't block the main thread; its result crosses back over
// postMessage and uploadLayers() (GL upload only) applies it on the main
// thread, which owns the canvas. loadAndRenderGds() still does both in one
// synchronous call for callers that don't need a Worker.
//
// GDS bytes still arrive via MEMFS (see bindings.cpp's parseGds, which is
// kept around for non-graphical testing of the parse path in isolation).
//
// Three self-contained pieces sit in their own files, since none of them
// touch any of the renderer state below: the GLSL sources (shaders.hpp), the
// stroke font the labels are drawn with (stroke_font.hpp), and the string and
// color primitives the .lyp reader is built on (lyp_util.hpp).

#include <GLES3/gl3.h>

#include <emscripten/bind.h>
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/val.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

#include <gdstk/gdstk.hpp>

#include "gds_common.hpp"
#include "lyp_util.hpp"
#include "shaders.hpp"
#include "stroke_font.hpp"

using namespace emscripten;
using namespace gdstk;

namespace {

struct PolygonRange {
    GLint first;
    GLsizei count;
    // World-space bounding box, used to skip glDrawArrays calls for polygons
    // outside the current viewport (see is_range_visible/draw_frame) --
    // large designs can have millions of off-screen polygons while zoomed
    // in, and issuing a draw call per polygon regardless is the dominant
    // per-frame cost at that point.
    float min_x, max_x, min_y, max_y;
};

// One reused cell's geometry, uploaded once and drawn instance_count times
// via glDraw*Instanced with a per-instance 2x3 affine (see a_iCol0/a_iCol1/
// a_iTranslate in kVertexShaderSrc) -- built from an instance group produced
// by collect_instanced() so that a cell placed 100,000 times (whether as one
// AREF or 100,000 individual SREFs at different positions/rotations) costs
// one unique shape's worth of triangulation/VBO memory instead of 100,000
// copies of it. fill_vbo/outline_vbo/outline_ebo hold the *unit* shape (the
// cell's geometry in its own local frame); instance_vbo holds 6 floats
// (col0.xy, col1.xy, translate.xy) per instance, bound with
// glVertexAttribDivisor so it advances once per instance.
struct InstancedBatch {
    GLuint fill_vbo = 0;
    GLsizei fill_vertex_count = 0;
    GLuint outline_vbo = 0;
    GLuint outline_ebo = 0;
    GLsizei outline_index_count = 0;
    // Vertices in outline_vbo, as opposed to indices into it -- what the pick
    // pass draws as GL_POINTS to find a vertex to snap the ruler to.
    GLsizei outline_vertex_count = 0;
    // Shared across every layer touched by the same instance group (a group
    // can span multiple layers, e.g. metal + via) -- deleting the same GL
    // buffer name more than once is a defined no-op per the GL/WebGL2 spec,
    // so clear_layers() doesn't need to track ownership per copy.
    GLuint instance_vbo = 0;
    GLsizei instance_count = 0;
};

constexpr GLsizei kInstanceStrideFloats = 6;  // col0.xy, col1.xy, translate.xy

// One pair of VBOs per layer (fill triangles + outline points) holding all
// of that layer's non-instanced polygons back-to-back, plus per-polygon
// (first, count) ranges so each polygon's boundary can be expanded into its
// own closed ring of GL_LINES edges (a shared vertex buffer alone doesn't say
// where one polygon's boundary ends and the next begins), and triangle fans
// from ear-clipping are similarly per-polygon. Repeated references on this
// layer are drawn separately via instanced_batches instead of being flattened
// in here.
// One flattened GDSII/OASIS label: its world-space origin (the reference tree
// is already applied -- see collect_instanced), the text itself, and the
// anchor telling which corner/edge of the text box that origin is. Kept
// CPU-side rather than baked into a VBO at load time because the glyphs are
// drawn at a fixed pixel size for only the labels currently on screen, which
// is a per-view decision (see rebuild_text_buffer) -- and because a full chip's
// worth of labels turned into geometry up front is hundreds of MB of vertices
// for text that is unreadable mush at anything but a close zoom.
struct TextLabel {
    float x = 0.0f, y = 0.0f;
    // gdstk's Anchor enum value (NW=0, N=1, NE=2, W=4, O=5, E=6, SW=8, S=9,
    // SE=10): bits 2-3 select the vertical edge, bits 0-1 the horizontal one.
    uint8_t anchor = 5;  // Anchor::O (centered), gdstk's default
    std::string text;
};

struct LayerBuffer {
    uint32_t layer;
    // GDS datatype: layers are keyed on the (layer, datatype) pair, not the
    // layer number alone, since real PDKs put many distinct styles on the same
    // layer number distinguished only by datatype. tag() packs the pair into
    // gdstk's 64-bit Tag, the key used by g_lyp_info and every by-tag bucket.
    uint32_t datatype = 0;
    uint64_t tag() const { return make_tag(layer, datatype); }
    GLuint outline_vbo = 0;
    GLuint fill_vbo = 0;
    // Index buffer over outline_vbo, holding every polygon's boundary as
    // explicit GL_LINES edge pairs (see upload_geometry) -- lets draw_frame
    // draw every outline polygon on the layer in a single glDrawElements call
    // when the whole layer is on screen, instead of one glDrawArrays per
    // polygon.
    GLuint outline_ebo = 0;
    GLsizei outline_index_count = 0;
    // Vertices in outline_vbo, as opposed to indices into it (outline_ebo names
    // each one twice, once per edge it belongs to) -- what the pick pass draws
    // as GL_POINTS to find a vertex to snap the ruler to.
    GLsizei outline_vertex_count = 0;
    // Total vertex count in fill_vbo -- triangle lists have no loop-closing
    // constraint, so the whole buffer can be drawn in one glDrawArrays call
    // with no indices needed.
    GLsizei fill_vertex_count = 0;
    // Repeated references on this layer -- see InstancedBatch.
    std::vector<InstancedBatch> instanced_batches;
    // This layer's labels, in world space (see TextLabel). Drawn only while
    // the Text toggle is on, and folded into the cull box below so a
    // text-only layer (labels but no polygons at all, which real decks do
    // have) still passes draw_frame's bbox test.
    std::vector<TextLabel> labels;
    // Logical polygon count on this layer, including instanced copies
    // (unit-shape polygon count * instance_count for each batch) -- every
    // layer draws unconditionally in one call each for fill/outline (see
    // draw_frame), so per-polygon geometry doesn't need to stick around at
    // runtime, just this count for the UI/stats readout.
    uint32_t polygon_count = 0;
    std::array<float, 4> fill_color{};
    std::array<float, 4> frame_color{};
    float hatch_angle = 0.0f;
    float pattern_type = 0.0f;  // see kFragmentShaderSrc's patternType branches
    bool visible = true;
    // Union of every polygon's bbox on this layer, so draw_frame can skip
    // the whole layer with one check instead of scanning every polygon when
    // the layer isn't on screen at all.
    float min_x = HUGE_VAL, max_x = -HUGE_VAL, min_y = HUGE_VAL, max_y = -HUGE_VAL;
};

// Index value that marks a primitive-restart boundary in an outline_ebo.
// WebGL2 (like GLES 3.0) always treats the max value of the index type as a
// restart marker for indexed draws -- unlike desktop GL, there's no
// GL_PRIMITIVE_RESTART capability to glEnable and no way to disable it, so
// no setup call is needed beyond using this value.
constexpr uint32_t kRestartIndex = 0xFFFFFFFFu;

// GPU memory accounting behind the #renderStats readout (see
// update_render_stats). WebGL exposes no way to query driver-side allocation,
// so this tracks what we asked for: every glBufferData in this file goes
// through buffer_data_tracked and every glDeleteBuffers through
// delete_buffer_tracked, keyed on the buffer name so the running total stays
// right in the two cases a naive "add on upload" counter gets wrong --
// re-uploading into an existing name (glBufferData replaces the old
// allocation rather than adding to it), and clear_layers deleting the same
// InstancedBatch buffer once per layer that shares it (only the first erase
// finds anything). It counts requested byte sizes, so it excludes driver
// padding, the shader/program objects, and the default framebuffer.
std::unordered_map<GLuint, size_t> g_buffer_bytes;
uint64_t g_gpu_buffer_bytes = 0;
// Merge mode's coverage mask (see resize_canvas) -- the one texture big
// enough to matter, and it resizes with the window rather than the design.
uint64_t g_mask_tex_bytes = 0;

void buffer_data_tracked(GLenum target, GLuint name, GLsizeiptr size, const void* data, GLenum usage) {
    glBufferData(target, size, data, usage);
    size_t& slot = g_buffer_bytes[name];
    g_gpu_buffer_bytes -= slot;
    slot = (size_t)size;
    g_gpu_buffer_bytes += slot;
}

void delete_buffer_tracked(GLuint* name) {
    auto it = g_buffer_bytes.find(*name);
    if (it != g_buffer_bytes.end()) {
        g_gpu_buffer_bytes -= it->second;
        g_buffer_bytes.erase(it);
    }
    glDeleteBuffers(1, name);
}

// Parsed out of a single <properties>/<group-members> block in a .lyp file.
// Keyed in g_lyp_info by the (layer, datatype) Tag it applies to. Persists
// across GDS reloads (same as the old g_lyp_colors did) so re-opening/replacing
// the GDS file keeps previously-applied layer styling.
struct LypEntry {
    std::string name;
    // Display name of the enclosing top-level <properties> group in the .lyp
    // (e.g. "Metals", "Waveguide"), or empty for an ungrouped/flat entry. Used
    // only to organize the sidebar into collapsible categories; empty otherwise.
    std::string group;
    std::array<float, 4> fill_color{};
    std::array<float, 4> frame_color{};
    bool has_fill = false;
    bool has_frame = false;
    bool visible = true;
    int order = 0;
};

GLuint g_program = 0;
GLuint g_vao = 0;
GLint g_loc_position = -1;
GLint g_loc_i_col0 = -1;
GLint g_loc_i_col1 = -1;
GLint g_loc_i_translate = -1;
GLint g_loc_resolution = -1;
GLint g_loc_color = -1;
GLint g_loc_offset = -1;
GLint g_loc_zoom = -1;
GLint g_loc_use_hatch = -1;
GLint g_loc_pattern_type = -1;
GLint g_loc_hatch_angle = -1;
GLint g_loc_hatch_spacing = -1;
GLint g_loc_hatch_width = -1;

// Frame-time readout for the stats overlay: EMA of the delta between
// consecutive requestAnimationFrame timestamps. Only meaningful while frames
// are being produced back-to-back (pan/zoom); deltas over 500ms are idle
// gaps between interactions, not rendering time, and are skipped.
double g_last_frame_timestamp = 0.0;
float g_frame_ms_ema = 0.0f;

// Merge mode's GL objects (see draw_layer_merged): the coverage-mask program
// (kVertexShaderSrc + kMaskFragmentShaderSrc, so it needs its own copies of
// the camera uniforms), the composite program, and one screen-sized R8 mask
// texture + FBO reused by every merged layer every frame.
GLuint g_mask_program = 0;
GLint g_mask_loc_resolution = -1;
GLint g_mask_loc_offset = -1;
GLint g_mask_loc_zoom = -1;
GLuint g_comp_program = 0;
GLint g_comp_loc_fill_color = -1;
GLint g_comp_loc_frame_color = -1;
GLint g_comp_loc_pattern_type = -1;
GLint g_comp_loc_hatch_angle = -1;
GLint g_comp_loc_hatch_spacing = -1;
GLint g_comp_loc_hatch_width = -1;
GLint g_comp_loc_show_fill = -1;
GLint g_comp_loc_mask_scale = -1;
GLuint g_mask_fbo = 0;
GLuint g_mask_tex = 0;
// Supersampling factor for the coverage mask (mask texture = canvas size *
// this) -- merge mode's anti-aliasing (see kCompositeFragmentShaderSrc).
// Recomputed per resize: drops to 1 if 2x the canvas would exceed
// GL_MAX_TEXTURE_SIZE (AA off, but never blank).
int g_mask_scale = 2;

// ---- Pick pass (see pick_snap_at) ------------------------------------------
// Nothing about the geometry survives on the CPU after uploadLayers -- only
// VBOs -- so the ruler's "what is near this point" question is answered by
// rasterizing that geometry again. A small window of the scene around a screen
// point is drawn into an integer framebuffer carrying, per fragment, what kind
// of thing it is and where in the world it sits, and that window is read back. The target is tiny and
// fixed rather than canvas-sized: the pass supplies its own u_resolution and
// u_offset, so setting them to the window size and the world point under the
// cursor makes the texture cover exactly kPickSize x kPickSize canvas pixels
// centred there, at the camera's current zoom.
constexpr int kPickSize = 33;  // odd, so the window has a centre pixel
GLuint g_pick_program = 0;
GLint g_pick_loc_resolution = -1;
GLint g_pick_loc_offset = -1;
GLint g_pick_loc_zoom = -1;
GLint g_pick_loc_id = -1;
GLuint g_pick_fbo = 0;
GLuint g_pick_tex = 0;
// Readback destination, RGBA per texel: (id, world x bits, world y bits, 1).
std::vector<uint32_t> g_pick_buffer;

// Background-grid program state (see kGridFragmentShaderSrc/draw_grid).
GLuint g_grid_program = 0;
GLint g_grid_loc_resolution = -1;
GLint g_grid_loc_zoom = -1;
GLint g_grid_loc_pan_mod = -1;
GLint g_grid_loc_spacing = -1;
GLint g_grid_loc_level_alpha = -1;
GLint g_grid_loc_color = -1;
GLint g_grid_loc_half_width = -1;

// On-screen pitch (px) the coarser of the grid's two decade levels is kept at
// or above, i.e. the pitch the finer level reaches just before the decade
// counter ticks over. The finer level rides a decade below this, fading out
// between kGridFadeMinPx and kGridFadeFullPx so it never gets dense enough to
// read as a wash -- the fade-out has to complete by kGridTargetPx / 10 for the
// decade crossing to be invisible (see kGridFragmentShaderSrc).
constexpr float kGridTargetPx = 110.0f;
constexpr float kGridFadeMinPx = 13.0f;
constexpr float kGridFadeFullPx = 55.0f;
// Half-width of a grid line before its 1px anti-aliasing ramp; the grid is
// meant to sit under the geometry, so it stays hairline-thin.
constexpr float kGridHalfWidthPx = 0.15f;
// Alpha ceiling for grid lines, drawn in the theme's ink color. Higher on light
// backgrounds, which is the opposite of what it looks like it should be: alpha
// blends in the framebuffer's sRGB-encoded values, and equal steps in those are
// worth far less perceived lightness near white than near black. Matching the
// dark theme's ~10 points of L* against a 0.98 background takes about 0.11
// alpha, so an alpha that reads as a faint grid on near-black vanishes outright
// on near-white -- these two are perceptual siblings, not a typo.
constexpr float kGridAlphaDark = 0.09f;
constexpr float kGridAlphaLight = 0.13f;

// Constant pixel pitch for every layer's pattern -- only the angle and
// pattern kind vary per layer (see pattern_for_layer) so stacked layers
// stay visually distinguishable from each other.
constexpr float kHatchSpacingPx = 10.0f;
constexpr float kHatchHalfWidthPx = 0.25f;
constexpr int kPatternTypeCount = 4;  // diagonal, cross-hatch, dots, grid

std::vector<LayerBuffer> g_layers;
std::unordered_map<uint64_t, LypEntry> g_lyp_info;
int g_lyp_order_counter = 0;

// Total polygon count across all layers (set once in uploadLayers), used as
// the denominator for the "visible polygons" stat draw_frame recomputes
// every frame (see update_render_stats).
uint64_t g_total_polygons = 0;

float g_zoom = 1.0f;
float g_pan_x = 0.0f;
float g_pan_y = 0.0f;
int g_canvas_width = 0;
int g_canvas_height = 0;

// Camera state captured the last time the view was framed to the design
// (see uploadLayers) -- what the "Reset View" button restores.
float g_fit_zoom = 1.0f;
float g_fit_pan_x = 0.0f;
float g_fit_pan_y = 0.0f;

// Design bbox in world space, used to keep pan/zoom from wandering off into
// empty space. min > max (the HUGE_VALF/-HUGE_VALF sentinel pair) means "no
// geometry loaded yet" -- clamp_pan() is a no-op in that case.
float g_bbox_min_x = HUGE_VALF;
float g_bbox_max_x = -HUGE_VALF;
float g_bbox_min_y = HUGE_VALF;
float g_bbox_max_y = -HUGE_VALF;

// Zoom-out is bounded relative to the fit-to-window zoom, so how far you can
// back a design off depends on the design: 20x past fitting it is 20x past
// fitting it whether that is a die or a single cell.
constexpr float kMinZoomRatio = 0.05f;

// Zoom-in is bounded absolutely instead, in pixels per micron. It can be:
// every file's coordinates are normalized to microns at parse time (unit=1e-6
// in bindings.cpp -- see update_scale_bar), so a pixels-per-micron number
// means the same thing in every layout, which a ratio against the fit zoom
// does not. A fit-relative ceiling let you in ~1nm deep on a small cell and
// only ~50nm deep on a full die, purely because the die's bbox is bigger.
//
// The value is the deepest zoom at which the scale bar still reads 2nm: at
// 60000 px/um the 120px-target bar lands exactly on 2nm and the grid's fine
// decade is 1nm drawn at a 60px pitch (one notch further in and both halve).
// That pair -- 2nm bar, 1nm grid -- is the intended bottom of the range, so
// the constant is pinned to it rather than to a round power of ten.
constexpr float kMaxZoomPxPerUm = 60000.0f;

bool g_dragging = false;
int g_last_mouse_x = 0;
int g_last_mouse_y = 0;

// Last known pointer position over the canvas, in canvas-relative pixels, and
// whether the pointer is over the canvas at all. Kept because the world point
// under the cursor is a function of both the pointer *and* the camera: zooming
// with the mouse held still moves the layout under it, so the readout has to be
// recomputable from a stored screen position rather than only on a move event.
float g_cursor_x = 0.0f;
float g_cursor_y = 0.0f;
bool g_cursor_inside = false;

// Ruler ("measure") tool state -- see setMeasureMode/on_mousedown. While the
// mode is active, clicks measure instead of pan: the first click anchors a
// ruler's start point, the line then tracks the cursor (g_measure_pending),
// and a second click finishes it into g_measurements. Measurements are
// world-space, so they stay glued to the geometry across pan/zoom; only the
// readout labels (one .measure-label per ruler inside #measureLabels,
// repositioned every draw_frame) live in screen space.
//
// A list rather than one ruler because the interesting questions are
// comparisons -- this gap against that one, this width at both ends of a taper
// -- and a tool that forgets the previous answer the moment you ask the next
// one makes you hold it in your head. Finished rulers outlive the mode too:
// once placed they're annotations on the layout, not a mode you're in.
struct Measurement {
    float x0, y0, x1, y1;
};
bool g_measure_mode = false;
std::vector<Measurement> g_measurements;
bool g_measure_pending = false;   // first point placed, waiting for the second click
float g_measure_x0 = 0.0f, g_measure_y0 = 0.0f;
float g_measure_x1 = 0.0f, g_measure_y1 = 0.0f;
GLuint g_measure_vbo = 0;

// Where the ruler would land if clicked right now, when that's a snap onto real
// geometry rather than the bare cursor position (see pick_snap_at). Drawn as a
// small square while measure mode is on, so the snap is something you aim with
// rather than something you discover afterwards in the numbers.
bool g_snap_active = false;
float g_snap_x = 0.0f, g_snap_y = 0.0f;

// Selected-cell highlight: the world-space boxes of whichever row the hierarchy
// panel has selected (see setCellHighlight / draw_cell_highlight), drawn as
// dashed outlines over the geometry. Clicking a row already frames that cell, but
// framing only answers "which shapes are it" while the camera stays put -- zoom
// out to see the cell in context and the answer is gone. The outlines are what
// survive panning and zooming away, which is what makes the tree readable
// *against* the layout rather than instead of it. Dashed because a solid
// rectangle at a layer's line weight is indistinguishable from a drawn shape --
// nothing in a layout file is dashed, so the dashes read as the viewer's own
// annotation rather than as something in the design.
//
// A list rather than one box because a row stands for every placement of a cell
// by one parent: a cell placed 40 times gets 40 outlines, one per copy, since a
// single box around all of them is a box around mostly other cells' geometry.
// Flat, 4 floats (minX, minY, maxX, maxY) per box.
std::vector<float> g_highlight_boxes;
GLuint g_highlight_vbo = 0;

// The outline's half-thickness, its dash and gap lengths, and the smallest box
// it is drawn around -- all in pixels, so it keeps the same weight and dash
// rhythm at every zoom (which is half of what stops it reading as geometry, the
// other half being that it's dashed at all), and a cell far smaller than its
// own outline still shows up as a mark you can aim the view at.
constexpr float kHighlightRingPx = 1.5f;
constexpr float kHighlightDashPx = 7.0f;
constexpr float kHighlightGapPx = 5.0f;
constexpr float kHighlightMinPx = 20.0f;

// Backstop on one frame's worth of outline vertices (floats). A selection can
// hold up to kMaxRowPlacements boxes, and a pathological one -- a thousand
// placements each larger than the viewport -- would otherwise rebuild a
// multi-megabyte buffer on every pan frame. Boxes past the ceiling are dropped
// for that frame; reaching it at all means the outlines are already a solid mat
// of dashes, where the thousandth box changes nothing anyone can see.
constexpr size_t kMaxHighlightVerts = 240000;

// "Go to Coordinate" flash: a crosshair dropped on the coordinate the view was
// just sent to, which fades out on its own a couple of seconds later. Panning
// to a coordinate leaves it at the centre of the screen with nothing to say
// which pixel it actually is -- and once the clamp in goToPoint has had its
// say, or the view is nudged afterwards, it isn't even the centre any more.
// The crosshair is what points at the spot; it expires rather than needing to
// be dismissed, because a pasted coordinate is a place you're being shown, not
// a selection you're holding (unlike the cell outlines, which are).
//
// Screen-sized like every other annotation here, with a gap at the middle so
// the crosshair frames the point instead of covering it.
float g_goto_x = 0.0f;
float g_goto_y = 0.0f;
double g_goto_start_ms = -1.0;  // negative: nothing flashing
GLuint g_goto_vbo = 0;
constexpr double kGotoHoldMs = 1300.0;  // full strength, then:
constexpr double kGotoFadeMs = 900.0;   // faded out over this
constexpr float kGotoGapPx = 7.0f;      // clear space either side of the point
constexpr float kGotoArmPx = 30.0f;     // where each arm ends
constexpr float kGotoRingPx = 14.0f;    // radius of the ring the arms cross
constexpr int kGotoRingSegments = 24;

bool g_frame_requested = false;

// Toggles the hatched polygon fill (the "infill") on/off for every layer at
// once -- see draw_frame and setShowInfill. Outlines are unaffected.
bool g_show_infill = false;

// Merge-overlaps mode: when on, each layer draws as the union of its polygons
// (screen-space coverage mask + composite pass, see draw_layer_merged) so
// edges interior to overlapping/abutting polygons disappear and only the
// layer's true boundary shows. Purely a render-time effect -- the parsed
// geometry is untouched, so toggling never re-parses or re-uploads anything.
bool g_merge_mode = false;

// Label rendering on/off (the panel's "Text" checkbox -- see setShowText).
// Off by default, like the other render-mode toggles: on a full chip the
// labels are dense enough to bury the geometry, so drawing them is opt-in.
bool g_show_text = false;

// Background reference grid on/off (the panel's "Grid" checkbox -- see
// setShowGrid/draw_grid). On by default, unlike the other render-mode toggles:
// it costs one fullscreen pass regardless of design size, and it is drawn
// faintly enough underneath everything else that it reads as part of the
// canvas rather than as something overlaid on the layout.
bool g_show_grid = true;

// Light/dark theme, pushed in by setTheme() from the viewer's theme block
// (viewer.js) once it has read VS Code's active theme, and again whenever the
// user switches themes. Dark is the default because that's what the panel and
// the page background are styled as before any JS runs (viewer.html).
//
// Everything the renderer draws that is background-dependent keys off these
// two: the color the canvas clears to, and the "ink" the ruler, the selected
// marker and the background grid are stroked in (white on near-black;
// near-black on white). The fallback layer palette reads g_light_theme
// directly (see default_color -- nearly half of it is too light to read
// against white). Colors that came from a .lyp are left exactly as authored
// either way: that file is the user's own deck, not our palette.
bool g_light_theme = false;
std::array<float, 3> g_bg_color = {0.06f, 0.06f, 0.07f};
std::array<float, 3> g_ink_color = {1.0f, 1.0f, 1.0f};
// The selected cell's ring. Its own color rather than the ink: red is the
// marker overlay's and ink is the ruler's, and a highlight that reused either
// would read as one of those. The two values are the --accent token from
// viewer.html, so the ring and the selected row in the panel are the same blue.
std::array<float, 3> g_highlight_color = {0.29f, 0.62f, 1.0f};

// Text GL state. One VBO holds every on-screen label's glyph segments as
// GL_LINES, grouped into one range per layer so each range can be drawn in the
// layer's own frame color. It is rebuilt whenever the view moves (the buffer
// only holds the labels currently in view) or the label/visibility state
// changes -- see rebuild_text_buffer / draw_text.
GLuint g_text_program = 0;
GLint g_text_loc_resolution = -1;
GLint g_text_loc_offset = -1;
GLint g_text_loc_zoom = -1;
GLint g_text_loc_color = -1;
GLuint g_text_vbo = 0;
struct TextRange {
    size_t layer_index;
    GLint first;
    GLsizei count;
};
std::vector<TextRange> g_text_ranges;
bool g_text_dirty = true;
// The world-space region the current buffer was built for, and the zoom it was
// built at. The glyph vertices themselves don't depend on the camera at all
// (the pixel offset is applied after it), so the only reason to rebuild is
// that the view moved somewhere the buffer has no labels for -- which is why
// the build region is deliberately larger than the viewport: ordinary panning
// then reuses the buffer instead of re-uploading it every frame.
// min > max is the never-built sentinel.
float g_text_built_min_x = HUGE_VALF;
float g_text_built_max_x = -HUGE_VALF;
float g_text_built_min_y = HUGE_VALF;
float g_text_built_max_y = -HUGE_VALF;
float g_text_built_zoom = -1.0f;
// Whether that build stopped at kMaxLabelsPerFrame -- see draw_text.
bool g_text_built_capped = false;
// Labels held across all layers (for the stats readout), and how many of them
// the last rebuild actually drew.
uint64_t g_total_labels = 0;
uint64_t g_labels_drawn = 0;

// ---- DRC/LVS marker overlay -------------------------------------------------
// Violation markers from a KLayout .lyrdb / Calibre DRC results database
// (parsed and flattened in JS -- see src/marker-parsers.js), drawn as a fixed
// red highlight after every layer, unaffected by layer visibility / infill /
// merge modes. Geometry is retained CPU-side (unlike layers) because
// visibility is per-category and selection changes need VBO rebuilds; marker
// counts are small (10^2-10^5 vertices) so a full rebuild on toggle is cheap.
// Rebuild is lazy: state changes set g_markers_dirty + request_redraw(), and
// draw_markers() rebuilds before drawing. The CPU-side state lives outside
// any g_gl_ready guard so headless Node runs can still exercise
// setMarkers()/getMarkerStats() without a GL context.
// Categories start hidden: a fresh marker load draws nothing until the user
// turns on the rulechecks they care about (a full DRC deck lighting up all at
// once is noise). viewer.js's checkboxes default to match.
struct MarkerCategoryGL {
    bool visible = false;
};
struct MarkerGeom {
    std::vector<float> poly_verts;        // ring vertices, x,y pairs, rings back-to-back
    std::vector<uint32_t> poly_counts;    // vertex count per ring
    std::vector<uint32_t> poly_item_ids;  // owning item per ring
    std::vector<float> edge_verts;        // packed segments, x0,y0,x1,y1 each
    std::vector<uint32_t> edge_item_ids;  // owning item per segment
    std::vector<int32_t> item_category;   // category index per item (size == item count)
    std::vector<float> item_bboxes;       // 4 floats per item (min>max sentinel = no geometry)
};
MarkerGeom g_markers;
std::vector<MarkerCategoryGL> g_marker_categories;
int g_selected_marker = -1;   // item id, -1 = none
// Overall overlay opacity (the panel's Opacity slider): scales every marker
// pass's alpha at draw time, so changing it never rebuilds VBOs.
float g_marker_opacity = 1.0f;
bool g_markers_dirty = false; // CPU state changed -> rebuild VBOs on next frame
GLuint g_marker_outline_vbo = 0;
GLuint g_marker_outline_ebo = 0; // restart-joined GL_LINE_LOOPs, one per ring
GLsizei g_marker_outline_index_count = 0;
GLuint g_marker_fill_vbo = 0; // triangulated translucent fill
GLsizei g_marker_fill_vertex_count = 0;
GLuint g_marker_edge_vbo = 0; // GL_LINES
GLsizei g_marker_edge_vertex_count = 0;
GLuint g_marker_sel_vbo = 0; // selected item's segments, redrawn on top in white
GLsizei g_marker_sel_vertex_count = 0;
// Edge end ticks have a constant on-screen length, so they're regenerated
// from this CPU copy of the currently-visible edge segments whenever g_zoom
// changed since the last build (edge counts are small).
std::vector<float> g_marker_visible_edges;
GLuint g_marker_tick_vbo = 0;
GLsizei g_marker_tick_vertex_count = 0;
float g_marker_tick_zoom = -1.0f;

bool markers_present() { return !g_markers.item_category.empty(); }

GLuint compile_shader(GLenum type, const char* source) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &source, nullptr);
    glCompileShader(shader);
    return shader;
}

// Attribute locations are bound to fixed indices before linking (rather than
// queried after) so every program built from kVertexShaderSrc -- the main
// layer program and merge mode's mask program -- agrees on them: attribute
// enables, pointers, divisors, and the generic identity values set in
// init_gl are all per-index context/VAO state, so agreeing on indices lets
// draw_frame switch programs without redoing any of that setup. Harmless for
// programs that don't declare these names (the composite pass has no
// attributes at all).
constexpr GLuint kAttrPosition = 0;
constexpr GLuint kAttrICol0 = 1;
constexpr GLuint kAttrICol1 = 2;
constexpr GLuint kAttrITranslate = 3;
// The label program's per-vertex pixel offset (see kTextVertexShaderSrc). Its
// own index rather than a reused one, so enabling it can't disturb the
// instancing attributes' divisors or generic values.
constexpr GLuint kAttrTextOffset = 4;

GLuint link_program(const char* vs_src, const char* fs_src) {
    GLuint program = glCreateProgram();
    glAttachShader(program, compile_shader(GL_VERTEX_SHADER, vs_src));
    glAttachShader(program, compile_shader(GL_FRAGMENT_SHADER, fs_src));
    glBindAttribLocation(program, kAttrPosition, "a_position");
    glBindAttribLocation(program, kAttrICol0, "a_iCol0");
    glBindAttribLocation(program, kAttrICol1, "a_iCol1");
    glBindAttribLocation(program, kAttrITranslate, "a_iTranslate");
    glBindAttribLocation(program, kAttrTextOffset, "a_offset");
    glLinkProgram(program);
    return program;
}

// False in environments with no real WebGL2-capable canvas -- notably plain
// Node, which is how parseGds() (bindings.cpp) is exercised for headless
// parse-path testing (see RENDERING_REWRITE.md's phase-1 verification).
// main() checks this before touching any further GL/DOM state so that
// non-graphical testing still works after this file's GL init runs
// automatically at module load.
bool g_gl_ready = false;

bool init_gl() {
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx = emscripten_webgl_create_context("#glCanvas", &attrs);
    if (ctx <= 0) return false;
    if (emscripten_webgl_make_context_current(ctx) != EMSCRIPTEN_RESULT_SUCCESS) return false;

    g_program = link_program(shaders::kVertexShaderSrc, shaders::kFragmentShaderSrc);

    g_loc_position = kAttrPosition;
    g_loc_i_col0 = kAttrICol0;
    g_loc_i_col1 = kAttrICol1;
    g_loc_i_translate = kAttrITranslate;
    g_loc_resolution = glGetUniformLocation(g_program, "u_resolution");
    g_loc_color = glGetUniformLocation(g_program, "u_color");
    g_loc_offset = glGetUniformLocation(g_program, "u_offset");
    g_loc_zoom = glGetUniformLocation(g_program, "u_zoom");
    g_loc_use_hatch = glGetUniformLocation(g_program, "u_useHatch");
    g_loc_pattern_type = glGetUniformLocation(g_program, "u_patternType");
    g_loc_hatch_angle = glGetUniformLocation(g_program, "u_hatchAngle");
    g_loc_hatch_spacing = glGetUniformLocation(g_program, "u_hatchSpacing");
    g_loc_hatch_width = glGetUniformLocation(g_program, "u_hatchWidth");

    glGenVertexArrays(1, &g_vao);
    glBindVertexArray(g_vao);

    // Generic (array-disabled) values for the per-instance affine attributes:
    // the identity map, so static (non-instanced) draws -- which never enable
    // these arrays -- pass a_position straight through (see kVertexShaderSrc).
    // These are context state, not VAO state, so setting them once here holds
    // for every later draw that leaves the arrays disabled.
    if (g_loc_i_col0 >= 0) glVertexAttrib2f(g_loc_i_col0, 1.0f, 0.0f);
    if (g_loc_i_col1 >= 0) glVertexAttrib2f(g_loc_i_col1, 0.0f, 1.0f);
    if (g_loc_i_translate >= 0) glVertexAttrib2f(g_loc_i_translate, 0.0f, 0.0f);

    // Label overlay program (see draw_text). Same camera uniforms as the layer
    // program plus the per-vertex pixel offset that keeps glyphs a constant
    // on-screen size.
    g_text_program = link_program(shaders::kTextVertexShaderSrc, shaders::kTextFragmentShaderSrc);
    g_text_loc_resolution = glGetUniformLocation(g_text_program, "u_resolution");
    g_text_loc_offset = glGetUniformLocation(g_text_program, "u_offset");
    g_text_loc_zoom = glGetUniformLocation(g_text_program, "u_zoom");
    g_text_loc_color = glGetUniformLocation(g_text_program, "u_color");

    // Merge mode's two extra programs (see draw_layer_merged). The composite
    // program's sampler is bound to texture unit 0 once here.
    g_mask_program = link_program(shaders::kVertexShaderSrc, shaders::kMaskFragmentShaderSrc);
    g_mask_loc_resolution = glGetUniformLocation(g_mask_program, "u_resolution");
    g_mask_loc_offset = glGetUniformLocation(g_mask_program, "u_offset");
    g_mask_loc_zoom = glGetUniformLocation(g_mask_program, "u_zoom");

    g_comp_program = link_program(shaders::kCompositeVertexShaderSrc, shaders::kCompositeFragmentShaderSrc);
    g_comp_loc_fill_color = glGetUniformLocation(g_comp_program, "u_fillColor");
    g_comp_loc_frame_color = glGetUniformLocation(g_comp_program, "u_frameColor");
    g_comp_loc_pattern_type = glGetUniformLocation(g_comp_program, "u_patternType");
    g_comp_loc_hatch_angle = glGetUniformLocation(g_comp_program, "u_hatchAngle");
    g_comp_loc_hatch_spacing = glGetUniformLocation(g_comp_program, "u_hatchSpacing");
    g_comp_loc_hatch_width = glGetUniformLocation(g_comp_program, "u_hatchWidth");
    g_comp_loc_show_fill = glGetUniformLocation(g_comp_program, "u_showFill");
    g_comp_loc_mask_scale = glGetUniformLocation(g_comp_program, "u_maskScale");
    glUseProgram(g_comp_program);
    glUniform1i(glGetUniformLocation(g_comp_program, "u_mask"), 0);

    // Background grid (see draw_grid) -- shares the composite pass's
    // attribute-free fullscreen triangle. Array uniforms are queried by their
    // first element, which is the location the whole array is set through.
    g_grid_program = link_program(shaders::kCompositeVertexShaderSrc, shaders::kGridFragmentShaderSrc);
    g_grid_loc_resolution = glGetUniformLocation(g_grid_program, "u_resolution");
    g_grid_loc_zoom = glGetUniformLocation(g_grid_program, "u_zoom");
    g_grid_loc_pan_mod = glGetUniformLocation(g_grid_program, "u_panMod[0]");
    g_grid_loc_spacing = glGetUniformLocation(g_grid_program, "u_spacing[0]");
    g_grid_loc_level_alpha = glGetUniformLocation(g_grid_program, "u_levelAlpha[0]");
    g_grid_loc_color = glGetUniformLocation(g_grid_program, "u_color");
    g_grid_loc_half_width = glGetUniformLocation(g_grid_program, "u_halfWidthPx");

    // The mask texture's storage is (re)allocated at the canvas size in
    // resize_canvas; only the texture object and its FBO attachment are
    // created here.
    // LINEAR, not NEAREST: the composite pass reads the mask with bilinear
    // taps so coverage varies continuously as the true edge moves sub-texel
    // -- the anti-aliasing depends on it (see kCompositeFragmentShaderSrc).
    glGenTextures(1, &g_mask_tex);
    glBindTexture(GL_TEXTURE_2D, g_mask_tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glGenFramebuffers(1, &g_mask_fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, g_mask_fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_mask_tex, 0);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    // Pick target (see run_pick_pass). RGBA32UI rather than a float format
    // because it's color-renderable in core WebGL2 while RGBA32F needs
    // EXT_color_buffer_float; world positions ride through it as raw bits.
    // Integer textures can only be sampled NEAREST, and this one is never
    // sampled at all -- only glReadPixels'd -- but the filter still has to be
    // set or the texture is incomplete.
    g_pick_program = link_program(shaders::kPickVertexShaderSrc, shaders::kPickFragmentShaderSrc);
    g_pick_loc_resolution = glGetUniformLocation(g_pick_program, "u_resolution");
    g_pick_loc_offset = glGetUniformLocation(g_pick_program, "u_offset");
    g_pick_loc_zoom = glGetUniformLocation(g_pick_program, "u_zoom");
    g_pick_loc_id = glGetUniformLocation(g_pick_program, "u_pickId");
    glGenTextures(1, &g_pick_tex);
    glBindTexture(GL_TEXTURE_2D, g_pick_tex);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA32UI, kPickSize, kPickSize, 0, GL_RGBA_INTEGER,
                 GL_UNSIGNED_INT, nullptr);
    glGenFramebuffers(1, &g_pick_fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, g_pick_fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, g_pick_tex, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        // Ruler snapping is an addition to a tool that works without it, so a
        // driver that won't render to RGBA32UI loses the snap and nothing else:
        // pick_snap_at reports no hit and every point lands where clicked.
        EM_ASM({ console.warn('[GDS] pick FBO incomplete; ruler snapping is off'); });
        glDeleteFramebuffers(1, &g_pick_fbo);
        g_pick_fbo = 0;
    } else {
        g_pick_buffer.assign((size_t)kPickSize * kPickSize * 4, 0u);
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    glEnable(GL_BLEND);
    // Standard source-over for color, but the destination alpha is deliberately
    // driven to stay saturated rather than being blended the same way.
    //
    // The canvas is created with the emscripten defaults, which include
    // alpha=true and premultipliedAlpha=true, so the browser composites the
    // drawing buffer over the page as premultiplied: what you see is
    // fbColor + (1 - fbAlpha) * pageBackground. A plain
    // glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA) applies to the alpha
    // channel too, so every semi-transparent draw pulls fbAlpha *below* the 1.0
    // the clear wrote (alpha 0.13 over an opaque pixel leaves 0.887), and the
    // compositor then adds 11% of the page background back on top of it. On a
    // dark page that add-back is invisible; on a light one it is nearly as
    // bright as the pixel it is diluting, so anything drawn in dark ink at low
    // alpha -- the background grid especially -- washes back out to within a
    // percent of the background and disappears. GL_ONE for the alpha source
    // keeps fbAlpha at 1 everywhere, making the canvas fully opaque and the
    // compositing step a no-op, so low-alpha ink reads the same in both themes.
    glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    return true;
}

// Mirrors the old JS per-layer color fallback hash (viewer.js:151-156) for
// layers with no matching .lyp entry.
std::array<float, 4> default_color(uint32_t layer, uint32_t datatype) {
    // Fold datatype into the seed so two datatypes on the same layer number
    // don't collapse to one fallback color. datatype 0 leaves seed == layer,
    // preserving the exact colors this used before datatype support existed.
    uint32_t seed = layer + datatype * 97u;
    float r = (float)((seed * 65) % 200 + 55) / 255.0f;
    float g = (float)((seed * 115) % 200 + 55) / 255.0f;
    float b = (float)((seed * 175) % 200 + 55) / 255.0f;
    // The band above is 55..254 per channel -- picked to stand out against a
    // near-black background, which puts about half of it (every layer whose
    // hash lands high in the band) at a relative luminance over 0.6, i.e.
    // invisible on white. Halving all three channels keeps each layer's hue
    // and saturation exactly (it's a value-only change in HSV, so layers stay
    // as distinguishable from each other as they were) and moves the band to
    // 27..127, which reads on white the way the original reads on black.
    if (g_light_theme) {
        r *= 0.5f;
        g *= 0.5f;
        b *= 0.5f;
    }
    return {r, g, b, 0.8f};
}

// Spreads layers across the 4 pattern kinds and 6 hatch angles
// (0/30/60/90/120/150 degrees) so adjacent layer numbers -- which is how
// overlapping layers are usually numbered in real GDS decks -- don't end up
// looking like the same pattern. Angle is ignored by the dot/grid kinds
// (they're already rotation-symmetric-ish), but assigning one anyway keeps
// this a single deterministic function of the layer number.
void pattern_for_layer(uint32_t layer, uint32_t datatype, float& out_pattern_type, float& out_angle) {
    constexpr float kPi = 3.14159265358979323846f;
    // Same datatype-0-preserving seed as default_color, so distinct datatypes
    // on one layer number also get distinguishable hatch patterns.
    uint32_t seed = layer + datatype * 97u;
    out_pattern_type = (float)(seed % kPatternTypeCount);
    uint32_t angle_index = (seed / kPatternTypeCount) % 6;
    out_angle = (float)angle_index * (kPi / 6.0f);
}

// Resolves a layer's fill/frame color + hatch pattern from g_lyp_info (falling
// back to the hash color above for layers with no .lyp entry, or for the
// half of a fill/frame pair that's missing from the entry). Deliberately does
// not touch layer.visible: a theme switch recolors through here (the fallback
// palette depends on the theme), and resetting visibility would throw away
// every layer checkbox the user had set.
void resolve_layer_colors(LayerBuffer& layer) {
    pattern_for_layer(layer.layer, layer.datatype, layer.pattern_type, layer.hatch_angle);
    auto it = g_lyp_info.find(layer.tag());
    if (it == g_lyp_info.end()) {
        std::array<float, 4> base = default_color(layer.layer, layer.datatype);
        layer.fill_color = {base[0], base[1], base[2], 0.4f};
        layer.frame_color = {base[0], base[1], base[2], 0.9f};
        return;
    }
    const LypEntry& e = it->second;
    std::array<float, 4> base = default_color(layer.layer, layer.datatype);
    if (e.has_fill) {
        layer.fill_color = e.fill_color;
    } else if (e.has_frame) {
        layer.fill_color = {e.frame_color[0], e.frame_color[1], e.frame_color[2], 0.45f};
    } else {
        layer.fill_color = {base[0], base[1], base[2], 0.4f};
    }
    if (e.has_frame) {
        layer.frame_color = e.frame_color;
    } else if (e.has_fill) {
        layer.frame_color = {e.fill_color[0], e.fill_color[1], e.fill_color[2], 0.9f};
    } else {
        layer.frame_color = {base[0], base[1], base[2], 0.9f};
    }
}

// Colors plus the visibility the .lyp asks for -- what a fresh load or a .lyp
// (re)load applies, as opposed to the color-only pass a theme switch needs.
void apply_layer_colors(LayerBuffer& layer) {
    resolve_layer_colors(layer);
    auto it = g_lyp_info.find(layer.tag());
    layer.visible = it == g_lyp_info.end() ? true : it->second.visible;
}

void apply_lyp_to_layers() {
    for (LayerBuffer& layer : g_layers) apply_layer_colors(layer);
    // A .lyp can hide layers, and the label buffer only holds visible ones.
    g_text_dirty = true;
}

std::string rgba_to_css(const std::array<float, 4>& c) {
    char buf[64];
    snprintf(buf, sizeof(buf), "rgba(%d,%d,%d,%.3f)", (int)std::lround(c[0] * 255.0f),
             (int)std::lround(c[1] * 255.0f), (int)std::lround(c[2] * 255.0f), c[3]);
    return buf;
}

// Ear-clipping triangulation for filled rendering. GDS polygons are simple
// (non-self-intersecting) by convention -- including the "comb" slits some
// tools use to represent holes -- so plain ear clipping is sufficient; no
// need for a general/robust tessellator. Capped at kMaxTriangulatePoints
// since this is naive O(n^3) in the worst case (each of the ~n ear removals
// rescans the remaining ~n vertices against ~n inside-triangle tests); large
// polygons just render outline-only rather than risk stalling the load on a
// single pathological shape. Appends triangle vertex indices (into pts) to
// out_indices; leaves it untouched (empty, if previously cleared by the
// caller) on failure.
constexpr uint64_t kMaxTriangulatePoints = 512;

void triangulate(const Array<Vec2>& pts, std::vector<uint32_t>& out_indices) {
    uint64_t n = pts.count;
    if (n < 3 || n > kMaxTriangulatePoints) return;

    std::vector<uint32_t> remaining(n);
    for (uint64_t i = 0; i < n; i++) remaining[i] = (uint32_t)i;

    double area2 = 0;
    for (uint64_t i = 0; i < n; i++) {
        const Vec2& a = pts[i];
        const Vec2& b = pts[(i + 1) % n];
        area2 += a.x * b.y - b.x * a.y;
    }
    if (area2 < 0) std::reverse(remaining.begin(), remaining.end());

    auto cross = [](const Vec2& o, const Vec2& a, const Vec2& b) {
        return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    };
    auto point_in_tri = [&](const Vec2& p, const Vec2& a, const Vec2& b, const Vec2& c) {
        double d1 = cross(a, b, p);
        double d2 = cross(b, c, p);
        double d3 = cross(c, a, p);
        bool has_neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
        bool has_pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
        return !(has_neg && has_pos);
    };

    uint64_t guard = 0;
    uint64_t max_iters = n * n + 16;
    while (remaining.size() > 3 && guard++ < max_iters) {
        uint64_t m = remaining.size();
        bool ear_found = false;
        for (uint64_t i = 0; i < m; i++) {
            uint64_t iprev = (i + m - 1) % m;
            uint64_t inext = (i + 1) % m;
            const Vec2& a = pts[remaining[iprev]];
            const Vec2& b = pts[remaining[i]];
            const Vec2& c = pts[remaining[inext]];
            if (cross(a, b, c) <= 0) continue;  // reflex/collinear vertex, not a convex ear tip
            bool any_inside = false;
            for (uint64_t j = 0; j < m; j++) {
                if (j == iprev || j == i || j == inext) continue;
                const Vec2& p = pts[remaining[j]];
                // Keyhole/comb polygons (the self-touching slits tools use to
                // represent holes) duplicate the slit's bridge vertices, and a
                // duplicate lands exactly on an ear corner -- point_in_tri is
                // boundary-inclusive, so without this exemption every ear near
                // the bridge is vetoed and triangulation stalls at zero.
                if (p == a || p == b || p == c) continue;
                if (point_in_tri(p, a, b, c)) {
                    any_inside = true;
                    break;
                }
            }
            if (any_inside) continue;
            out_indices.push_back(remaining[iprev]);
            out_indices.push_back(remaining[i]);
            out_indices.push_back(remaining[inext]);
            remaining.erase(remaining.begin() + i);
            ear_found = true;
            break;
        }
        // Degenerate input (e.g. self-touching/duplicate points) can leave no
        // valid ear -- bail with whatever triangles were already found rather
        // than looping; partial fill is fine, the outline still draws fully.
        if (!ear_found) return;
    }
    if (remaining.size() == 3) {
        out_indices.push_back(remaining[0]);
        out_indices.push_back(remaining[1]);
        out_indices.push_back(remaining[2]);
    }
}

// Computes a PolygonRange's world-space bbox from the flat [x0,y0,x1,y1,...]
// vertex buffer it indexes into (shared by both outline and fill ranges,
// since fill vertices are a subset of the same polygon points).
PolygonRange make_range(const std::vector<float>& verts, GLint first, GLsizei count) {
    PolygonRange range{first, count, HUGE_VALF, -HUGE_VALF, HUGE_VALF, -HUGE_VALF};
    for (GLsizei i = 0; i < count; i++) {
        float x = verts[(size_t)(first + i) * 2];
        float y = verts[(size_t)(first + i) * 2 + 1];
        range.min_x = std::min(range.min_x, x);
        range.max_x = std::max(range.max_x, x);
        range.min_y = std::min(range.min_y, y);
        range.max_y = std::max(range.max_y, y);
    }
    return range;
}

void set_inner_html(const char* id, const std::string& html) {
    val el = val::global("document").call<val>("getElementById", std::string(id));
    if (!el.isNull() && !el.isUndefined()) el.set("innerHTML", html);
}

void set_inner_text(const char* id, const std::string& text) {
    val el = val::global("document").call<val>("getElementById", std::string(id));
    if (!el.isNull() && !el.isUndefined()) el.set("innerText", text);
}

// dbuPerMicron is always 1.0 now -- gdstk's read_gds()/read_oas() are called
// with unit=1e-6, which normalizes every file's coordinates to microns at
// parse time (see bindings.cpp), so the old per-file scale factor the JS
// scale bar used to divide by no longer varies.
void update_scale_bar() {
    const double target_pixel_width = 120.0;
    double microns_value = target_pixel_width / g_zoom;
    if (!(microns_value > 0) || !std::isfinite(microns_value)) return;

    double magnitude = std::pow(10.0, std::floor(std::log10(microns_value)));
    double normalized = microns_value / magnitude;
    double step = magnitude;
    if (normalized >= 5) step = 5 * magnitude;
    else if (normalized >= 2) step = 2 * magnitude;
    double final_bar_pixels = step * g_zoom;

    val scale_bar = val::global("document").call<val>("getElementById", std::string("scaleBar"));
    if (!scale_bar.isNull() && !scale_bar.isUndefined()) {
        scale_bar["style"].set("width", std::to_string(final_bar_pixels) + "px");
    }

    char buf[64];
    if (step >= 1000) {
        snprintf(buf, sizeof(buf), "%.1f mm", step / 1000.0);
    } else if (step >= 1) {
        snprintf(buf, sizeof(buf), "%.0f \xC2\xB5m", step);  // µm, UTF-8
    } else {
        snprintf(buf, sizeof(buf), "%.0f nm", step * 1000.0);
    }
    set_inner_text("scaleLabel", buf);
}

// Inverse of the vertex shader's camera transform (see kVertexShaderSrc):
// canvas-relative pixel coordinates -> world coordinates. Same math on_wheel
// inlines for its zoom-around-cursor anchor.
void screen_to_world(float screen_x, float screen_y, float& world_x, float& world_y) {
    float px = screen_x - (float)g_canvas_width * 0.5f;
    float py = (float)g_canvas_height * 0.5f - screen_y;
    world_x = g_pan_x + px / g_zoom;
    world_y = g_pan_y + py / g_zoom;
}

// Forward camera transform: world -> canvas-relative pixel coordinates. Used
// to pin the measure label to the ruler midpoint on every redraw.
void world_to_screen(float world_x, float world_y, float& screen_x, float& screen_y) {
    screen_x = (world_x - g_pan_x) * g_zoom + (float)g_canvas_width * 0.5f;
    screen_y = (float)g_canvas_height * 0.5f - (world_y - g_pan_y) * g_zoom;
}

// World units are always microns (see update_scale_bar's dbuPerMicron note);
// picks nm/µm/mm to keep the number readable. %.4g rather than a fixed
// precision so short distances don't drown in trailing zeros.
std::string format_distance_um(double microns) {
    char buf[64];
    if (microns >= 1000.0) {
        snprintf(buf, sizeof(buf), "%.4g mm", microns / 1000.0);
    } else if (microns >= 1.0) {
        snprintf(buf, sizeof(buf), "%.4g \xC2\xB5m", microns);  // µm, UTF-8
    } else {
        snprintf(buf, sizeof(buf), "%.4g nm", microns * 1000.0);
    }
    return buf;
}

// The finer of the background grid's two decade pitches, in microns -- i.e.
// what one grid square currently means (see draw_grid, which draws this pitch
// and ten times it). Pulled out of draw_grid because the pointer readout
// formats itself against the same number: the digits worth showing are exactly
// the ones the grid on screen can distinguish. 0 for a degenerate zoom.
double grid_fine_spacing() {
    const double zoom = (double)g_zoom;
    if (!(zoom > 0.0) || !std::isfinite(zoom)) return 0.0;
    const double fine = std::pow(10.0, std::floor(std::log10((double)kGridTargetPx / zoom)));
    if (!(fine > 0.0) || !std::isfinite(fine)) return 0.0;
    return fine;
}

// How many decimals the pointer coordinate is written with at the current
// zoom -- see format_coord_pair below for why that is the grid's business.
// Split out because the clipboard form (getCoordinateTextAt) has to
// agree with it digit for digit: copying a coordinate that reads differently
// from the one on screen is copying a different number as far as anyone
// reading it is concerned.
int coord_readout_decimals() {
    double step = grid_fine_spacing();
    if (!(step > 0.0)) step = 1.0;
    // Exact: step is a power of ten by construction.
    const int decade = (int)std::lround(std::log10(step));
    return std::clamp(1 - decade, 0, 6);
}

// The pointer readout's "X: … Y: …" line. Always microns -- the unit the whole
// viewer works in -- rather than switching to nm or mm the way the scale bar and
// the ruler do. Those two report one distance at a time, where the unit is free
// to follow the magnitude; this reports a position you watch while moving the
// pointer, and a unit that changes underneath it means two readings taken
// seconds apart aren't comparable without noticing that the suffix moved.
//
// Zoom still decides the precision, just not the unit: the number of decimals
// resolves a tenth of the background grid's current step, so the digits on
// screen are the ones the grid can distinguish and no more. Unlike the ruler's
// %.4g that count is fixed for both halves of the pair, since a decimal point
// that shifts as the pointer crosses zero is unreadable.
std::string format_coord_pair(double x_um, double y_um) {
    const int decimals = coord_readout_decimals();
    char buf[128];
    // µm, UTF-8.
    snprintf(buf, sizeof(buf), "X: %.*f  Y: %.*f \xC2\xB5m", decimals, x_um, decimals, y_um);
    return buf;
}

// Rewrites #coordReadout (viewer.html) with the world coordinate under the
// pointer, or hides it when the pointer isn't over the canvas. Called from
// every event that can move the world under the cursor -- the pointer moving,
// and the camera moving beneath a stationary pointer (wheel zoom, "go to").
void update_coord_readout() {
    if (!g_gl_ready) return;
    val el = val::global("document").call<val>("getElementById", std::string("coordReadout"));
    if (el.isNull() || el.isUndefined()) return;
    if (!g_cursor_inside) {
        el["classList"].call<void>("add", std::string("hidden"));
        return;
    }
    float wx, wy;
    screen_to_world(g_cursor_x, g_cursor_y, wx, wy);
    el.set("textContent", format_coord_pair(wx, wy));
    el["classList"].call<void>("remove", std::string("hidden"));
}

// The world coordinate at a canvas pixel, as clipboard text. Called with the
// position of a right-click, which is why it takes one rather than reading the
// tracked pointer: the menu answers for the pixel that was clicked, and nothing
// has to stay true about where the pointer wandered while the menu was open.
//
// Canvas pixels are CSS pixels here -- resize_canvas sizes the canvas from
// window.innerWidth/Height with no devicePixelRatio scaling -- so the webview
// hands a mouse event's clientX/clientY straight in.
//
// "X=…, Y=…" rather than the readout's "X: … Y: … µm" because a copied
// coordinate is going somewhere: back into "Go to Coordinate", into a script,
// into a message to whoever asked where the short was. That shape is one the
// parser on the other end already reads (coord-parse.js), and it stays readable
// as prose; the trailing unit does not survive that round trip, and every
// number this viewer produces is microns anyway.
//
// The digits are the readout's, so what lands on the clipboard is what was on
// screen -- more would be precision the zoom never showed anyone.
std::string getCoordinateTextAt(double screen_x, double screen_y) {
    float wx, wy;
    screen_to_world((float)screen_x, (float)screen_y, wx, wy);
    const int decimals = coord_readout_decimals();
    char buf[128];
    snprintf(buf, sizeof(buf), "X=%.*f, Y=%.*f", decimals, (double)wx, decimals, (double)wy);
    return buf;
}

// One ruler's readout: the distance, then its components and the angle it runs
// at. The angle is signed and measured from +x through the ruler's own
// direction (first point to second), so it answers "what angle did I draw
// this at" rather than folding two opposite directions onto one number.
std::string measure_label_html(const Measurement& m) {
    double dx = (double)m.x1 - m.x0;
    double dy = (double)m.y1 - m.y0;
    double dist = std::sqrt(dx * dx + dy * dy);
    std::string html = "<b>" + format_distance_um(dist) + "</b><br>\xCE\x94x " +
                       format_distance_um(std::fabs(dx)) + " \xC2\xB7 \xCE\x94y " +
                       format_distance_um(std::fabs(dy));  // Δx · Δy
    if (dist > 0.0) {
        char buf[32];
        // ∠, degrees. A zero-length ruler has no direction to report.
        snprintf(buf, sizeof(buf), " \xC2\xB7 \xE2\x88\xA0 %.1f\xC2\xB0",
                 std::atan2(dy, dx) * 180.0 / 3.14159265358979323846);
        html += buf;
    }
    return html;
}

// Repositions/re-fills one .measure-label per ruler at that ruler's midpoint,
// inside #measureLabels (viewer.html). Called from draw_frame so the labels
// follow their world-space rulers across pan/zoom with no event plumbing of
// their own; the divs are created and removed here as the ruler count changes,
// since there is no fixed number of them any more.
void update_measure_labels() {
    val document = val::global("document");
    val container = document.call<val>("getElementById", std::string("measureLabels"));
    if (container.isNull() || container.isUndefined()) return;

    const size_t needed = g_measurements.size() + (g_measure_pending ? 1 : 0);
    val children = container["children"];  // live collection
    while (children["length"].as<size_t>() < needed) {
        val div = document.call<val>("createElement", std::string("div"));
        div.set("className", std::string("measure-label"));
        container.call<void>("appendChild", div);
    }
    while (children["length"].as<size_t>() > needed) {
        container.call<void>("removeChild", container["lastElementChild"]);
    }
    if (needed == 0) return;

    for (size_t i = 0; i < needed; i++) {
        const Measurement m = i < g_measurements.size()
                                  ? g_measurements[i]
                                  : Measurement{g_measure_x0, g_measure_y0, g_measure_x1, g_measure_y1};
        val el = children[(unsigned)i];
        el.set("innerHTML", measure_label_html(m));
        float sx, sy;
        world_to_screen((m.x0 + m.x1) * 0.5f, (m.y0 + m.y1) * 0.5f, sx, sy);
        el["style"].set("left", std::to_string(sx) + "px");
        el["style"].set("top", std::to_string(sy) + "px");
    }
}

// A ruler's line segment plus a short perpendicular tick at each endpoint, at a
// constant on-screen length (so the world size divides by zoom).
void append_measure_verts(std::vector<float>& verts, const Measurement& m) {
    verts.insert(verts.end(), {m.x0, m.y0, m.x1, m.y1});
    float dx = m.x1 - m.x0;
    float dy = m.y1 - m.y0;
    float len = std::sqrt(dx * dx + dy * dy);
    if (len <= 0.0f) return;
    float tick = 6.0f / g_zoom;  // 6px half-length ticks
    float nx = -dy / len * tick;
    float ny = dx / len * tick;
    verts.insert(verts.end(), {m.x0 - nx, m.y0 - ny, m.x0 + nx, m.y0 + ny,
                               m.x1 - nx, m.y1 - ny, m.x1 + nx, m.y1 + ny});
}

// Half-width of the open square drawn around a snapped point, in pixels.
constexpr float kSnapMarkerPx = 5.0f;

// The snap indicator: a small open square around the point a click would land
// on. Constant on-screen size like the ticks, so it reads the same at any zoom.
void append_snap_marker(std::vector<float>& verts, float x, float y) {
    const float r = kSnapMarkerPx / g_zoom;
    const float cx[4] = {x - r, x + r, x + r, x - r};
    const float cy[4] = {y - r, y - r, y + r, y + r};
    for (int i = 0; i < 4; i++) {
        const int k = (i + 1) & 3;
        verts.insert(verts.end(), {cx[i], cy[i], cx[k], cy[k]});
    }
}

// Draws every ruler -- the finished ones and the one being placed -- plus the
// snap indicator, in one call. Reuses the layer shader: the instance
// attributes' generic identity values (see init_gl) pass positions through, and
// u_useHatch=0 gives a solid line. The VBO is small and re-uploaded whenever
// anything moves.
void draw_measure_line() {
    std::vector<float> verts;
    for (const Measurement& m : g_measurements) append_measure_verts(verts, m);
    if (g_measure_pending) {
        append_measure_verts(verts, {g_measure_x0, g_measure_y0, g_measure_x1, g_measure_y1});
    }
    if (g_measure_mode && g_snap_active) append_snap_marker(verts, g_snap_x, g_snap_y);
    if (verts.empty()) return;

    if (!g_measure_vbo) glGenBuffers(1, &g_measure_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, g_measure_vbo);
    buffer_data_tracked(GL_ARRAY_BUFFER, g_measure_vbo, (GLsizeiptr)(verts.size() * sizeof(float)),
                        verts.data(), GL_DYNAMIC_DRAW);
    glEnableVertexAttribArray(g_loc_position);
    glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
    glUniform4f(g_loc_color, g_ink_color[0], g_ink_color[1], g_ink_color[2], 0.95f);
    glUniform1f(g_loc_use_hatch, 0.0f);
    glDrawArrays(GL_LINES, 0, (GLsizei)(verts.size() / 2));
}

bool marker_item_visible(uint32_t item_id) {
    if (item_id >= g_markers.item_category.size()) return false;
    int32_t cat = g_markers.item_category[item_id];
    // Out-of-range category (shouldn't happen; flattenMarkerModel guarantees
    // valid indices) draws rather than silently vanishing.
    if (cat < 0 || (size_t)cat >= g_marker_categories.size()) return true;
    return g_marker_categories[(size_t)cat].visible;
}

void delete_marker_gl_buffers() {
    auto del = [](GLuint& buf) {
        if (buf) {
            delete_buffer_tracked(&buf);
            buf = 0;
        }
    };
    del(g_marker_outline_vbo);
    del(g_marker_outline_ebo);
    del(g_marker_fill_vbo);
    del(g_marker_edge_vbo);
    del(g_marker_sel_vbo);
    del(g_marker_tick_vbo);
    g_marker_outline_index_count = 0;
    g_marker_fill_vertex_count = 0;
    g_marker_edge_vertex_count = 0;
    g_marker_sel_vertex_count = 0;
    g_marker_tick_vertex_count = 0;
    g_marker_tick_zoom = -1.0f;
    g_marker_visible_edges.clear();
}

// Rebuilds every marker VBO from g_markers, skipping items whose category is
// hidden. Polygons get a restart-joined LINE_LOOP outline EBO (same trick as
// LayerBuffer.outline_ebo) plus ear-clipped fill triangles; edges get one
// GL_LINES buffer; the selected item's segments are additionally copied into
// g_marker_sel_vbo for the white emphasis pass.
void rebuild_marker_buffers() {
    std::vector<float> outline_verts;
    std::vector<uint32_t> outline_indices;
    std::vector<float> fill_verts;
    std::vector<float> sel_verts;
    g_marker_visible_edges.clear();

    std::vector<Vec2> ring_pts;
    std::vector<uint32_t> tri_indices;

    size_t cursor = 0; // float index into poly_verts
    for (size_t r = 0; r < g_markers.poly_counts.size(); r++) {
        uint32_t count = g_markers.poly_counts[r];
        const float* pts = g_markers.poly_verts.data() + cursor;
        cursor += (size_t)count * 2;
        if (cursor > g_markers.poly_verts.size()) break; // malformed payload
        uint32_t item = g_markers.poly_item_ids[r];
        // The selected item's white emphasis draws even when its category is
        // hidden -- selection is explicit intent, and with categories hidden
        // by default a browser click must still show *something* to zoom to.
        bool visible = marker_item_visible(item);
        bool selected = (int)item == g_selected_marker;
        if (!visible && !selected) continue;

        if (visible) {
            uint32_t first = (uint32_t)(outline_verts.size() / 2);
            for (uint32_t k = 0; k < count; k++) {
                outline_verts.push_back(pts[k * 2]);
                outline_verts.push_back(pts[k * 2 + 1]);
                outline_indices.push_back(first + k);
            }
            outline_indices.push_back(kRestartIndex);

            // Fill via the existing ear clipper -- it takes gdstk's
            // Array<Vec2>, so wrap the ring in a non-owning view (never
            // clear()ed).
            ring_pts.clear();
            for (uint32_t k = 0; k < count; k++) {
                ring_pts.push_back({(double)pts[k * 2], (double)pts[k * 2 + 1]});
            }
            Array<Vec2> view = {};
            view.items = ring_pts.data();
            view.count = ring_pts.size();
            view.capacity = ring_pts.size();
            tri_indices.clear();
            triangulate(view, tri_indices);
            for (uint32_t idx : tri_indices) {
                fill_verts.push_back((float)ring_pts[idx].x);
                fill_verts.push_back((float)ring_pts[idx].y);
            }
        }

        if (selected) {
            for (uint32_t k = 0; k < count; k++) {
                uint32_t kn = (k + 1) % count;
                sel_verts.push_back(pts[k * 2]);
                sel_verts.push_back(pts[k * 2 + 1]);
                sel_verts.push_back(pts[kn * 2]);
                sel_verts.push_back(pts[kn * 2 + 1]);
            }
        }
    }

    for (size_t s = 0; s < g_markers.edge_item_ids.size(); s++) {
        if ((s + 1) * 4 > g_markers.edge_verts.size()) break; // malformed payload
        uint32_t item = g_markers.edge_item_ids[s];
        const float* e = g_markers.edge_verts.data() + s * 4;
        if (marker_item_visible(item)) {
            g_marker_visible_edges.insert(g_marker_visible_edges.end(), e, e + 4);
        }
        if ((int)item == g_selected_marker) sel_verts.insert(sel_verts.end(), e, e + 4);
    }

    auto upload = [](GLuint& vbo, const std::vector<float>& data) {
        if (data.empty()) {
            if (vbo) {
                delete_buffer_tracked(&vbo);
                vbo = 0;
            }
            return;
        }
        if (!vbo) glGenBuffers(1, &vbo);
        glBindBuffer(GL_ARRAY_BUFFER, vbo);
        buffer_data_tracked(GL_ARRAY_BUFFER, vbo, (GLsizeiptr)(data.size() * sizeof(float)), data.data(),
                            GL_STATIC_DRAW);
    };

    upload(g_marker_outline_vbo, outline_verts);
    if (outline_verts.empty()) {
        if (g_marker_outline_ebo) {
            delete_buffer_tracked(&g_marker_outline_ebo);
            g_marker_outline_ebo = 0;
        }
        g_marker_outline_index_count = 0;
    } else {
        if (!g_marker_outline_ebo) glGenBuffers(1, &g_marker_outline_ebo);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g_marker_outline_ebo);
        buffer_data_tracked(GL_ELEMENT_ARRAY_BUFFER, g_marker_outline_ebo,
                            (GLsizeiptr)(outline_indices.size() * sizeof(uint32_t)), outline_indices.data(),
                            GL_STATIC_DRAW);
        g_marker_outline_index_count = (GLsizei)outline_indices.size();
    }
    upload(g_marker_fill_vbo, fill_verts);
    g_marker_fill_vertex_count = (GLsizei)(fill_verts.size() / 2);
    upload(g_marker_edge_vbo, g_marker_visible_edges);
    g_marker_edge_vertex_count = (GLsizei)(g_marker_visible_edges.size() / 2);
    upload(g_marker_sel_vbo, sel_verts);
    g_marker_sel_vertex_count = (GLsizei)(sel_verts.size() / 2);
    g_marker_tick_zoom = -1.0f; // visible edge set changed -> regenerate ticks
}

// Short perpendicular ticks at each visible edge's endpoints (same 6px
// half-length math as the measure-line ticks) so 1px edge markers stay
// findable when zoomed out. Zoom-dependent, so rebuilt into a small dynamic
// VBO whenever g_zoom changed since the last build.
void build_marker_ticks() {
    std::vector<float> ticks;
    ticks.reserve(g_marker_visible_edges.size() * 2);
    float tick = 6.0f / g_zoom;
    for (size_t i = 0; i + 3 < g_marker_visible_edges.size(); i += 4) {
        float x0 = g_marker_visible_edges[i];
        float y0 = g_marker_visible_edges[i + 1];
        float x1 = g_marker_visible_edges[i + 2];
        float y1 = g_marker_visible_edges[i + 3];
        float dx = x1 - x0;
        float dy = y1 - y0;
        float len = std::sqrt(dx * dx + dy * dy);
        // Degenerate (point-like) edge: arbitrary horizontal tick.
        float nx = tick, ny = 0.0f;
        if (len > 0.0f) {
            nx = -dy / len * tick;
            ny = dx / len * tick;
        }
        const float quad[8] = {x0 - nx, y0 - ny, x0 + nx, y0 + ny, x1 - nx, y1 - ny, x1 + nx, y1 + ny};
        ticks.insert(ticks.end(), quad, quad + 8);
    }
    if (!g_marker_tick_vbo) glGenBuffers(1, &g_marker_tick_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, g_marker_tick_vbo);
    buffer_data_tracked(GL_ARRAY_BUFFER, g_marker_tick_vbo, (GLsizeiptr)(ticks.size() * sizeof(float)),
                        ticks.data(), GL_DYNAMIC_DRAW);
    g_marker_tick_vertex_count = (GLsizei)(ticks.size() / 2);
    g_marker_tick_zoom = g_zoom;
}

// Draws the marker overlay. Called from draw_frame after the layer loop
// (above all layers, below the ruler) with g_program active and the camera
// uniforms already set; like draw_measure_line, the instance attributes'
// generic identity values pass positions through and u_useHatch=0 gives
// solid color.
void draw_markers() {
    if (!markers_present()) return;
    if (g_marker_opacity <= 0.0f) return;
    if (g_markers_dirty) {
        rebuild_marker_buffers();
        g_markers_dirty = false;
    }

    glUniform1f(g_loc_use_hatch, 0.0f);
    auto draw = [](GLuint vbo, GLenum mode, GLsizei count, float r, float g, float b, float a) {
        if (!vbo || count == 0) return;
        glBindBuffer(GL_ARRAY_BUFFER, vbo);
        glEnableVertexAttribArray(g_loc_position);
        glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
        glUniform4f(g_loc_color, r, g, b, a * g_marker_opacity);
        glDrawArrays(mode, 0, count);
    };

    // Translucent fill (always on -- deliberately ignores g_show_infill).
    draw(g_marker_fill_vbo, GL_TRIANGLES, g_marker_fill_vertex_count, 1.0f, 0.1f, 0.1f, 0.18f);

    if (g_marker_outline_vbo && g_marker_outline_ebo && g_marker_outline_index_count > 0) {
        glBindBuffer(GL_ARRAY_BUFFER, g_marker_outline_vbo);
        glEnableVertexAttribArray(g_loc_position);
        glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
        glUniform4f(g_loc_color, 1.0f, 0.15f, 0.15f, 0.95f * g_marker_opacity);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g_marker_outline_ebo);
        glDrawElements(GL_LINE_LOOP, g_marker_outline_index_count, GL_UNSIGNED_INT, 0);
    }

    draw(g_marker_edge_vbo, GL_LINES, g_marker_edge_vertex_count, 1.0f, 0.15f, 0.15f, 0.95f);
    if (!g_marker_visible_edges.empty() && g_zoom != g_marker_tick_zoom) build_marker_ticks();
    draw(g_marker_tick_vbo, GL_LINES, g_marker_tick_vertex_count, 1.0f, 0.15f, 0.15f, 0.95f);

    // Selected marker re-drawn on top in the theme's ink color -- the point is
    // maximum contrast against both the background and the red overlay.
    draw(g_marker_sel_vbo, GL_LINES, g_marker_sel_vertex_count, g_ink_color[0], g_ink_color[1],
         g_ink_color[2], 0.9f);
}

struct ViewRect {
    float min_x, max_x, min_y, max_y;
};

// World-space extent of the current viewport, derived from the same
// pan/zoom the vertex shader applies (see kVertexShaderSrc). Padded by one
// hatch spacing so screen-space fill patterns (computed from gl_FragCoord,
// not world position) don't visibly pop at the edge of the view as a
// polygon crosses the cull boundary.
ViewRect current_view_rect() {
    float half_w = (float)g_canvas_width * 0.5f / g_zoom + kHatchSpacingPx;
    float half_h = (float)g_canvas_height * 0.5f / g_zoom + kHatchSpacingPx;
    return {g_pan_x - half_w, g_pan_x + half_w, g_pan_y - half_h, g_pan_y + half_h};
}

bool bbox_intersects_view(float min_x, float max_x, float min_y, float max_y, const ViewRect& view) {
    return min_x <= view.max_x && max_x >= view.min_x && min_y <= view.max_y && max_y >= view.min_y;
}

// Writes the per-frame "visible polygons" readout into #renderStats (a span
// inside #ui, see uploadLayers). layers_drawn/layers_total count only the
// layer-level visibility/bbox skip in draw_frame -- there's no per-polygon
// culling anymore, so every drawn layer's polygons are all visible.
void update_render_stats(uint64_t visible_polygons, int layers_drawn, int layers_total) {
    char buf[448];
    int len = snprintf(buf, sizeof(buf), "Visible: %llu / %llu polygons<br>Render: no culling (%d / %d layers on screen)",
             (unsigned long long)visible_polygons, (unsigned long long)g_total_polygons, layers_drawn, layers_total);
    if (g_total_labels > 0 && len > 0 && (size_t)len < sizeof(buf)) {
        len += snprintf(buf + len, sizeof(buf) - (size_t)len, "<br>Labels: %llu / %llu drawn",
                        (unsigned long long)(g_show_text ? g_labels_drawn : 0),
                        (unsigned long long)g_total_labels);
    }
    // GPU memory we asked the driver for, split into the part that scales with
    // the design (vertex/index/instance buffers) and the part that scales with
    // the window (merge mode's coverage mask) -- they grow for unrelated
    // reasons, so a single total hides which one is moving. Actual driver
    // usage is higher and unqueryable from WebGL; see g_gpu_buffer_bytes.
    if (len > 0 && (size_t)len < sizeof(buf)) {
        const double mb = 1024.0 * 1024.0;
        len += snprintf(buf + len, sizeof(buf) - (size_t)len,
                        "<br>GPU: %.1f MB (geom %.1f + mask %.1f)",
                        (double)(g_gpu_buffer_bytes + g_mask_tex_bytes) / mb, (double)g_gpu_buffer_bytes / mb,
                        (double)g_mask_tex_bytes / mb);
    }
    // Frame time is only measured across back-to-back frames (see
    // draw_frame); before any interaction there's nothing meaningful to show.
    if (g_frame_ms_ema > 0.0f && len > 0 && (size_t)len < sizeof(buf)) {
        snprintf(buf + len, sizeof(buf) - (size_t)len, "<br>Frame: %.1f ms (%.0f fps)", g_frame_ms_ema,
                 1000.0f / g_frame_ms_ema);
    }
    set_inner_html("renderStats", buf);
}

// Upper bound on labels drawn in one frame. Text is only legible a few
// hundred labels to a screen; past this the extra glyphs are unreadable
// overlap that costs both the rebuild below and the draw. Hit only when
// zoomed out over a label-dense design, where the text is mush either way.
constexpr uint64_t kMaxLabelsPerFrame = 4000;

// Extra world-space margin on the label cull test: a label's glyphs run right
// and up from its origin (or are centered on it) in *screen* space, so an
// origin just off-screen can still have visible text. 400px covers a ~40
// character label at kTextCapHeightPx.
constexpr float kTextCullPadPx = 400.0f;

// How much larger than the viewport the buffer is built, per side, as a
// fraction of the viewport. Half a screen in every direction is enough that
// a normal drag doesn't leave the built region mid-gesture.
constexpr float kTextBuildMargin = 0.5f;

// Refills g_text_vbo with the glyph segments of every label in (a margin
// around) the current view, grouped into one contiguous range per layer so
// each range can be drawn in that layer's frame color. Labels outside the
// region are skipped entirely, so the buffer stays small no matter how many
// labels the design holds.
void rebuild_text_buffer() {
    g_text_ranges.clear();
    g_labels_drawn = 0;
    std::vector<float> vertices;

    const ViewRect view = current_view_rect();
    const float margin_x = (view.max_x - view.min_x) * kTextBuildMargin;
    const float margin_y = (view.max_y - view.min_y) * kTextBuildMargin;
    const ViewRect region = {view.min_x - margin_x, view.max_x + margin_x, view.min_y - margin_y,
                             view.max_y + margin_y};
    // On top of the margin, the glyphs of a label whose origin sits just
    // outside the region can still reach into it -- they extend from the
    // origin in screen space, so that reach is a pixel distance.
    const float pad = kTextCullPadPx / g_zoom;

    for (size_t i = 0; i < g_layers.size(); i++) {
        const LayerBuffer& layer = g_layers[i];
        if (!layer.visible || layer.labels.empty()) continue;
        if (!bbox_intersects_view(layer.min_x, layer.max_x, layer.min_y, layer.max_y, region)) continue;

        GLint first = (GLint)(vertices.size() / 4);
        for (const TextLabel& label : layer.labels) {
            if (g_labels_drawn >= kMaxLabelsPerFrame) break;
            if (label.x < region.min_x - pad || label.x > region.max_x + pad) continue;
            if (label.y < region.min_y - pad || label.y > region.max_y + pad) continue;
            stroke_font::append_text_vertices(label.text, label.x, label.y, label.anchor, vertices);
            g_labels_drawn++;
        }
        GLsizei count = (GLsizei)(vertices.size() / 4) - first;
        if (count > 0) g_text_ranges.push_back({i, first, count});
        if (g_labels_drawn >= kMaxLabelsPerFrame) break;
    }

    if (!vertices.empty()) {
        if (!g_text_vbo) glGenBuffers(1, &g_text_vbo);
        glBindBuffer(GL_ARRAY_BUFFER, g_text_vbo);
        buffer_data_tracked(GL_ARRAY_BUFFER, g_text_vbo, (GLsizeiptr)(vertices.size() * sizeof(float)),
                            vertices.data(), GL_DYNAMIC_DRAW);
    }
    g_text_dirty = false;
    g_text_built_min_x = region.min_x;
    g_text_built_max_x = region.max_x;
    g_text_built_min_y = region.min_y;
    g_text_built_max_y = region.max_y;
    g_text_built_zoom = g_zoom;
    g_text_built_capped = g_labels_drawn >= kMaxLabelsPerFrame;
}

// Draws the label overlay above the layer geometry (and below the markers and
// the ruler). Runs its own program -- the glyph vertices carry a pixel offset
// the layer shader knows nothing about -- and restores g_program afterwards,
// which is what the passes after it expect to still be bound.
void draw_text() {
    if (!g_show_text) return;
    const ViewRect view = current_view_rect();
    bool inside_built_region = view.min_x >= g_text_built_min_x && view.max_x <= g_text_built_max_x &&
                               view.min_y >= g_text_built_min_y && view.max_y <= g_text_built_max_y;
    // A capped build holds an arbitrary subset of a label-dense region, so the
    // labels it dropped have to be reconsidered whenever the zoom changes --
    // otherwise zooming in on an area whose labels lost the cap would show
    // nothing, since zooming in never leaves the built region.
    bool stale_cap = g_text_built_capped && g_zoom != g_text_built_zoom;
    if (g_text_dirty || !inside_built_region || stale_cap) {
        rebuild_text_buffer();
    }
    if (g_text_ranges.empty() || !g_text_vbo) return;

    glUseProgram(g_text_program);
    glUniform2f(g_text_loc_resolution, (float)g_canvas_width, (float)g_canvas_height);
    glUniform2f(g_text_loc_offset, g_pan_x, g_pan_y);
    glUniform1f(g_text_loc_zoom, g_zoom);

    const GLsizei stride = 4 * (GLsizei)sizeof(float);
    glBindBuffer(GL_ARRAY_BUFFER, g_text_vbo);
    glEnableVertexAttribArray(g_loc_position);
    glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, stride, (void*)0);
    glEnableVertexAttribArray(kAttrTextOffset);
    glVertexAttribPointer(kAttrTextOffset, 2, GL_FLOAT, GL_FALSE, stride, (void*)(2 * sizeof(float)));

    for (const TextRange& range : g_text_ranges) {
        const LayerBuffer& layer = g_layers[range.layer_index];
        // The layer's frame color, floored at a legible alpha -- a .lyp can
        // set a frame alpha low enough that 1px strokes all but disappear.
        glUniform4f(g_text_loc_color, layer.frame_color[0], layer.frame_color[1], layer.frame_color[2],
                    std::max(layer.frame_color[3], 0.9f));
        glDrawArrays(GL_LINES, range.first, range.count);
    }

    // a_offset is only ever fed by this pass; leaving the array enabled would
    // point the other programs' attribute 4 at a buffer they never bound.
    glDisableVertexAttribArray(kAttrTextOffset);
    glUseProgram(g_program);
}

float clamp_zoom_value(float zoom) {
    float min_zoom = g_fit_zoom * kMinZoomRatio;
    // max() rather than the constant alone: a design small enough that framing
    // it already needs more than kMaxZoomPxPerUm (a handful of nm across, or a
    // point marker's degenerate box) still has to be able to reach its own fit
    // zoom, or zoom-to-fit would be clamped away from actually fitting.
    float max_zoom = std::max(kMaxZoomPxPerUm, g_fit_zoom);
    return std::clamp(zoom, min_zoom, max_zoom);
}

// Keeps the design bbox from being panned entirely out of view: pan is
// clamped so the current viewport (half_w/half_h around it, same math as
// current_view_rect) always overlaps the bbox by at least a hair, rather
// than letting the user scroll off into empty space indefinitely.
void clamp_pan() {
    if (g_bbox_min_x > g_bbox_max_x) return;
    float half_w = (float)g_canvas_width * 0.5f / g_zoom;
    float half_h = (float)g_canvas_height * 0.5f / g_zoom;
    g_pan_x = std::clamp(g_pan_x, g_bbox_min_x - half_w, g_bbox_max_x + half_w);
    g_pan_y = std::clamp(g_pan_y, g_bbox_min_y - half_h, g_bbox_max_y + half_h);
}

// Points the three per-instance affine attributes at an InstancedBatch's
// instance VBO with a per-instance divisor / reverts them to the disabled
// (generic identity) state -- shared by draw_frame's normal path and
// draw_layer_merged's mask pass, which draw the same batches under different
// programs (the attribute indices are fixed at link time, see link_program).
void enable_instance_attribs(GLuint instance_vbo) {
    const GLsizei stride = kInstanceStrideFloats * (GLsizei)sizeof(float);
    glBindBuffer(GL_ARRAY_BUFFER, instance_vbo);
    glEnableVertexAttribArray(g_loc_i_col0);
    glVertexAttribPointer(g_loc_i_col0, 2, GL_FLOAT, GL_FALSE, stride, (void*)0);
    glVertexAttribDivisor(g_loc_i_col0, 1);
    glEnableVertexAttribArray(g_loc_i_col1);
    glVertexAttribPointer(g_loc_i_col1, 2, GL_FLOAT, GL_FALSE, stride, (void*)(2 * sizeof(float)));
    glVertexAttribDivisor(g_loc_i_col1, 1);
    glEnableVertexAttribArray(g_loc_i_translate);
    glVertexAttribPointer(g_loc_i_translate, 2, GL_FLOAT, GL_FALSE, stride, (void*)(4 * sizeof(float)));
    glVertexAttribDivisor(g_loc_i_translate, 1);
}

void disable_instance_attribs() {
    glDisableVertexAttribArray(g_loc_i_col0);
    glDisableVertexAttribArray(g_loc_i_col1);
    glDisableVertexAttribArray(g_loc_i_translate);
}

// ---- Pick pass --------------------------------------------------------------
// See the g_pick_* declarations above for why this exists at all: the geometry
// is gone from the CPU after upload, so anything that needs to know what is at
// a point on screen asks the rasterizer.

// Points the pick framebuffer at a screen point and clears it. The world point
// under that pixel comes back through out_wx/out_wy: it is both the pass's
// u_offset -- which is what centres the window on the cursor -- and the origin
// every hit is measured from. False means there is nothing to pick against, and
// nothing was bound, so end_pick_pass must not follow.
bool begin_pick_pass(float screen_x, float screen_y, float& out_wx, float& out_wy) {
    if (!g_gl_ready || !g_pick_fbo || g_layers.empty()) return false;
    screen_to_world(screen_x, screen_y, out_wx, out_wy);

    glBindFramebuffer(GL_FRAMEBUFFER, g_pick_fbo);
    glViewport(0, 0, kPickSize, kPickSize);
    // Integer color attachments cannot be blended -- drawing to one with
    // blending enabled is an error, not a silently ignored setting.
    glDisable(GL_BLEND);
    const GLuint zero[4] = {0u, 0u, 0u, 0u};
    glClearBufferuiv(GL_COLOR, 0, zero);

    glBindVertexArray(g_vao);
    glUseProgram(g_pick_program);
    glUniform2f(g_pick_loc_resolution, (float)kPickSize, (float)kPickSize);
    glUniform2f(g_pick_loc_offset, out_wx, out_wy);
    glUniform1f(g_pick_loc_zoom, g_zoom);
    return true;
}

// Reads the window into g_pick_buffer and puts back the canvas framebuffer,
// viewport and blending. The canvas itself is untouched by a pick -- nothing
// was drawn to it -- so no redraw is owed afterwards.
void end_pick_pass() {
    glReadPixels(0, 0, kPickSize, kPickSize, GL_RGBA_INTEGER, GL_UNSIGNED_INT, g_pick_buffer.data());
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, g_canvas_width, g_canvas_height);
    glEnable(GL_BLEND);
}

// The world rect the pick window covers, so the pass can do the same
// layer-level bbox skip draw_frame does. At any zoom past "whole design in
// view" this is what keeps a pick from touching most of the layout.
ViewRect pick_view_rect(float wx, float wy) {
    float half = (float)kPickSize * 0.5f / g_zoom;
    return {wx - half, wx + half, wy - half, wy + half};
}

// The picked point maps to clip 0, i.e. exactly halfway across the viewport, so
// this is where it lands in texel coordinates.
constexpr float kPickCenter = (float)kPickSize * 0.5f;

// Squared pixel distance from the picked point to texel (i, j)'s center. Purely
// a function of the indices -- the window is centred on the cursor by
// construction, so no world-space arithmetic is involved.
float pick_texel_dist2(int i, int j) {
    float dx = ((float)i + 0.5f) - kPickCenter;
    float dy = ((float)j + 0.5f) - kPickCenter;
    return dx * dx + dy * dy;
}

// ---- Ruler snapping ---------------------------------------------------------
// What a snap candidate is. A vertex anywhere in range beats any edge: a corner
// is a more specific answer than the line leading to it, and it's what people
// aim at when they measure between shapes.
constexpr uint32_t kPickKindEdge = 1u;
constexpr uint32_t kPickKindVertex = 2u;

// How far the ruler reaches for something to snap to. Wider than the identify
// radius: you point *at* a layer, but you aim *near* a corner.
constexpr float kSnapRadiusPx = 12.0f;

// Draws one layer's outline geometry, static and instanced, under whatever
// program is bound -- as GL_LINES through the edge index buffer, or as
// GL_POINTS over the raw vertices.
void draw_layer_outline(const LayerBuffer& layer, GLenum primitive) {
    auto draw = [&](GLuint vbo, GLuint ebo, GLsizei index_count, GLsizei vertex_count,
                    GLsizei instances) {
        if (!vbo) return;
        if (primitive == GL_POINTS ? vertex_count == 0 : ebo == 0) return;
        glBindBuffer(GL_ARRAY_BUFFER, vbo);
        glEnableVertexAttribArray(g_loc_position);
        glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
        if (primitive == GL_POINTS) {
            if (instances > 0) glDrawArraysInstanced(GL_POINTS, 0, vertex_count, instances);
            else glDrawArrays(GL_POINTS, 0, vertex_count);
            return;
        }
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, ebo);
        if (instances > 0) {
            glDrawElementsInstanced(GL_LINES, index_count, GL_UNSIGNED_INT, 0, instances);
        } else {
            glDrawElements(GL_LINES, index_count, GL_UNSIGNED_INT, 0);
        }
    };

    draw(layer.outline_vbo, layer.outline_ebo, layer.outline_index_count, layer.outline_vertex_count, 0);
    for (const InstancedBatch& batch : layer.instanced_batches) {
        enable_instance_attribs(batch.instance_vbo);
        draw(batch.outline_vbo, batch.outline_ebo, batch.outline_index_count,
             batch.outline_vertex_count, batch.instance_count);
        disable_instance_attribs();
    }
}

// Nearest snappable point to a screen position, in world coordinates. False
// means nothing within kSnapRadiusPx and the caller should use the bare cursor
// position.
//
// What comes back is exact, not quantized to the pixel that found it: the pick
// fragment shader carries each fragment's world position through as raw bits,
// and for a GL_POINTS draw that varying is constant across the point, so a hit
// texel holds the vertex's own coordinates -- the same float32 the VBO holds,
// which is as exact as anything in this renderer gets. For GL_LINES it
// interpolates to a point that lies on the segment. That is the whole reason
// snapping can work with no CPU-side geometry at all: the answer doesn't have
// to be found in a data structure, only rendered.
bool pick_snap_at(float screen_x, float screen_y, float& out_x, float& out_y) {
    float wx, wy;
    if (!begin_pick_pass(screen_x, screen_y, wx, wy)) return false;
    const ViewRect view = pick_view_rect(wx, wy);

    // Two passes over the layers rather than one interleaved pass, so a vertex
    // on an early layer can't be overwritten by an edge on a later one landing
    // in the same texel.
    for (GLenum primitive : {GL_LINES, GL_POINTS}) {
        glUniform1ui(g_pick_loc_id, primitive == GL_POINTS ? kPickKindVertex : kPickKindEdge);
        for (const LayerBuffer& layer : g_layers) {
            if (!layer.visible) continue;
            if (!bbox_intersects_view(layer.min_x, layer.max_x, layer.min_y, layer.max_y, view)) continue;
            draw_layer_outline(layer, primitive);
        }
    }
    end_pick_pass();

    int best_index = -1;
    uint32_t best_kind = 0;
    float best_dist2 = HUGE_VALF;
    const float radius2 = kSnapRadiusPx * kSnapRadiusPx;
    for (int j = 0; j < kPickSize; j++) {
        for (int i = 0; i < kPickSize; i++) {
            const size_t at = ((size_t)j * kPickSize + i) * 4;
            if (g_pick_buffer[at + 3] == 0u) continue;
            const float dist2 = pick_texel_dist2(i, j);
            if (dist2 > radius2) continue;
            const uint32_t kind = g_pick_buffer[at];
            if (!(kind > best_kind || (kind == best_kind && dist2 < best_dist2))) continue;
            best_kind = kind;
            best_dist2 = dist2;
            best_index = (int)at;
        }
    }
    if (best_index < 0) return false;
    std::memcpy(&out_x, &g_pick_buffer[(size_t)best_index + 1], sizeof(float));
    std::memcpy(&out_y, &g_pick_buffer[(size_t)best_index + 2], sizeof(float));
    return std::isfinite(out_x) && std::isfinite(out_y);
}

// Shift's constraint: hold the ruler to horizontal or vertical, whichever axis
// it already runs further along. Orthogonal only -- a layout's own geometry is
// what 45-degree measurements should come from, and snapping already provides
// those exactly.
void constrain_orthogonal(float x0, float y0, float& x1, float& y1) {
    if (std::fabs(x1 - x0) >= std::fabs(y1 - y0)) y1 = y0;
    else x1 = x0;
}

// Where a measure click or a moving ruler end actually lands, and whether that
// was a snap (which is what draws the indicator). Shift and snapping are
// deliberately exclusive: Shift asks for an exact axis, and a snap would pull
// the point straight back off it. Alt suspends snapping for the cases where the
// point wanted isn't on any geometry at all. Shift needs a first point to
// constrain against, hence `from_start`.
void resolve_measure_point(const EmscriptenMouseEvent* e, bool from_start, float& out_x, float& out_y) {
    if (e->shiftKey && from_start) {
        screen_to_world((float)e->targetX, (float)e->targetY, out_x, out_y);
        constrain_orthogonal(g_measure_x0, g_measure_y0, out_x, out_y);
        g_snap_active = false;
        return;
    }
    if (!e->altKey && pick_snap_at((float)e->targetX, (float)e->targetY, out_x, out_y)) {
        g_snap_active = true;
        g_snap_x = out_x;
        g_snap_y = out_y;
        return;
    }
    screen_to_world((float)e->targetX, (float)e->targetY, out_x, out_y);
    g_snap_active = false;
}

// Draws the background grid: one fullscreen triangle, no geometry, called
// straight after the clear so everything else lands on top of it.
//
// This is where the level of detail is chosen. The two decade pitches the
// shader draws are picked from the zoom alone: the finer one is the largest
// power of ten whose on-screen pitch is still at or under kGridTargetPx, and
// the coarser is ten times that. Since world units are microns (see
// update_scale_bar), those pitches are always round nm/µm/mm values that agree
// with the scale bar rather than arbitrary fractions of the viewport.
//
// The finer level's alpha ramps with its own on-screen pitch, not with the
// decade fraction, which is what makes zooming continuous: as the zoom passes a
// decade boundary the pitch each level is drawn at changes by a hair, so its
// alpha changes by a hair too -- see kGridFragmentShaderSrc for why the pair
// can be re-indexed mid-fade without anything visibly jumping. The pan offset
// is reduced modulo each pitch here, in double precision, because the shader
// cannot do it in float without tearing on a full-chip pan.
void draw_grid() {
    if (!g_show_grid || g_zoom <= 0.0f || !std::isfinite(g_zoom)) return;

    const double zoom = (double)g_zoom;
    // Underflow guard: a pitch that rounds to zero (absurd zoom, or a design
    // whose units make the fit zoom enormous) would divide by zero in the
    // shader and fill the screen -- grid_fine_spacing returns 0 for those.
    const double fine = grid_fine_spacing();
    if (!(fine > 0.0)) return;
    const double spacing[2] = {fine, fine * 10.0};

    float spacing_f[2];
    float pan_mod[4];
    float level_alpha[2];
    for (int i = 0; i < 2; i++) {
        spacing_f[i] = (float)spacing[i];
        pan_mod[i * 2] = (float)std::fmod((double)g_pan_x, spacing[i]);
        pan_mod[i * 2 + 1] = (float)std::fmod((double)g_pan_y, spacing[i]);
        // smoothstep(kGridFadeMinPx, kGridFadeFullPx, pitch in px)
        double t = (spacing[i] * zoom - (double)kGridFadeMinPx) /
                   ((double)kGridFadeFullPx - (double)kGridFadeMinPx);
        t = std::min(1.0, std::max(0.0, t));
        level_alpha[i] = (float)(t * t * (3.0 - 2.0 * t));
    }
    if (level_alpha[0] <= 0.0f && level_alpha[1] <= 0.0f) return;

    glUseProgram(g_grid_program);
    glUniform2f(g_grid_loc_resolution, (float)g_canvas_width, (float)g_canvas_height);
    glUniform1f(g_grid_loc_zoom, g_zoom);
    glUniform2fv(g_grid_loc_pan_mod, 2, pan_mod);
    glUniform1fv(g_grid_loc_spacing, 2, spacing_f);
    glUniform1fv(g_grid_loc_level_alpha, 2, level_alpha);
    glUniform4f(g_grid_loc_color, g_ink_color[0], g_ink_color[1], g_ink_color[2],
                g_light_theme ? kGridAlphaLight : kGridAlphaDark);
    glUniform1f(g_grid_loc_half_width, kGridHalfWidthPx);
    glDrawArrays(GL_TRIANGLES, 0, 3);
}

// Merge-mode path for one layer, two passes. Pass 1 rasterizes the layer's
// fill triangles (static + instanced, same VBOs the normal path draws) into
// the screen-sized R8 mask with blending off, collapsing any overlap into
// plain coverage -- the union of the layer's polygons, computed by the
// rasterizer instead of CPU polygon booleans. Pass 2 draws one fullscreen
// triangle that turns that mask into pixels: frame color along the coverage
// boundary, hatch fill inside, discard outside (see
// kCompositeFragmentShaderSrc). Alpha blending on the canvas is per-pass-2-
// fragment, so merged layers stack against other layers exactly like normal
// ones. Coverage comes from the triangulated fill data, so polygons that
// exceeded kMaxTriangulatePoints (rendered outline-only in normal mode)
// don't contribute here.
void draw_layer_merged(const LayerBuffer& layer) {
    bool has_fill = layer.fill_vbo != 0;
    for (const InstancedBatch& batch : layer.instanced_batches) {
        if (batch.fill_vbo) has_fill = true;
    }
    if (!has_fill) return;

    // Pass 1: coverage mask, rasterized at g_mask_scale times the canvas
    // resolution for anti-aliasing (see kCompositeFragmentShaderSrc). Only
    // the viewport changes -- the camera uniforms produce clip-space
    // coordinates, which are viewport-independent, so the same values place
    // every vertex at exactly scale x its canvas pixel position.
    glBindFramebuffer(GL_FRAMEBUFFER, g_mask_fbo);
    glViewport(0, 0, g_canvas_width * g_mask_scale, g_canvas_height * g_mask_scale);
    glDisable(GL_BLEND);
    glClearColor(0.0f, 0.0f, 0.0f, 0.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glUseProgram(g_mask_program);
    glUniform2f(g_mask_loc_resolution, (float)g_canvas_width, (float)g_canvas_height);
    glUniform2f(g_mask_loc_offset, g_pan_x, g_pan_y);
    glUniform1f(g_mask_loc_zoom, g_zoom);

    if (layer.fill_vbo) {
        glBindBuffer(GL_ARRAY_BUFFER, layer.fill_vbo);
        glEnableVertexAttribArray(g_loc_position);
        glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
        glDrawArrays(GL_TRIANGLES, 0, layer.fill_vertex_count);
    }
    for (const InstancedBatch& batch : layer.instanced_batches) {
        if (!batch.fill_vbo) continue;
        enable_instance_attribs(batch.instance_vbo);
        glBindBuffer(GL_ARRAY_BUFFER, batch.fill_vbo);
        glEnableVertexAttribArray(g_loc_position);
        glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
        glDrawArraysInstanced(GL_TRIANGLES, 0, batch.fill_vertex_count, batch.instance_count);
        disable_instance_attribs();
    }

    // Pass 2: composite boundary + fill onto the canvas, back at 1:1.
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glViewport(0, 0, g_canvas_width, g_canvas_height);
    glEnable(GL_BLEND);
    glUseProgram(g_comp_program);
    glUniform1i(g_comp_loc_mask_scale, g_mask_scale);
    glUniform4fv(g_comp_loc_fill_color, 1, layer.fill_color.data());
    glUniform4fv(g_comp_loc_frame_color, 1, layer.frame_color.data());
    glUniform1f(g_comp_loc_pattern_type, layer.pattern_type);
    glUniform1f(g_comp_loc_hatch_angle, layer.hatch_angle);
    glUniform1f(g_comp_loc_hatch_spacing, kHatchSpacingPx);
    glUniform1f(g_comp_loc_hatch_width, kHatchHalfWidthPx);
    glUniform1f(g_comp_loc_show_fill, g_show_infill ? 1.0f : 0.0f);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, g_mask_tex);
    // The fullscreen triangle comes from gl_VertexID; a_position must not be
    // an enabled array here or GL would read (and bounds-check) whatever
    // buffer the mask pass left bound.
    glDisableVertexAttribArray(g_loc_position);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glUseProgram(g_program);
}

// Draws the selected cell's outlines: one dashed rectangle per box in
// g_highlight_boxes, built as screen-thickness quads. Both properties are there
// to keep them from reading as part of the layout -- a solid thin rectangle is
// exactly what a drawn shape looks like, whereas nothing in a GDSII/OASIS file
// comes out dashed, so the dashes alone say "this is the viewer talking". The
// thickness doesn't depend on glLineWidth (WebGL is free to ignore any width but
// 1) and neither it nor the dash pitch depends on the zoom, so an outline keeps
// the same weight and rhythm at every scale rather than turning into geometry
// the closer you get.
//
// Like draw_measure_line it reuses the layer shader with u_useHatch=0 and
// re-uploads its vertices every frame: they're a function of the camera, and
// off-screen boxes and their dashes are skipped before they cost anything, so
// what's built is bounded by the viewport rather than by the selection.
void draw_cell_highlight() {
    if (g_highlight_boxes.empty()) return;

    float t = kHighlightRingPx / g_zoom;  // half-thickness
    float dash = kHighlightDashPx / g_zoom;
    float period = (kHighlightDashPx + kHighlightGapPx) / g_zoom;
    float min_world = kHighlightMinPx / g_zoom;

    // Clipping to the view is what bounds the work: zoomed into one corner of a
    // die-sized cell, a side is millions of pixels long, and every dash but the
    // handful on screen would be built only to fall outside the viewport.
    // Clipped, the dashes along one side can't outnumber the canvas's own size
    // in dashes -- and a selection's boxes that are off screen entirely (the
    // other 39 copies of a cell, while you look at one) cost four comparisons.
    //
    // The rect is computed here rather than taken from current_view_rect()
    // because that one pads by a *world* distance (it exists for the hatch
    // patterns), which at a high zoom is an arbitrarily large number of pixels
    // -- and it's precisely a pixel-sized viewport that bounds the dash count.
    // Two dash periods of pad keeps a dash straddling the edge from popping.
    float half_w = (float)g_canvas_width * 0.5f / g_zoom + 2.0f * period;
    float half_h = (float)g_canvas_height * 0.5f / g_zoom + 2.0f * period;
    const ViewRect view = {g_pan_x - half_w, g_pan_x + half_w, g_pan_y - half_h, g_pan_y + half_h};

    std::vector<float> verts;
    auto quad = [&verts](float x0, float y0, float x1, float y1) {
        const float v[12] = {x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1};
        verts.insert(verts.end(), v, v + 12);
    };

    // One side of one box, as dashes along [lo, hi] of one axis. The dash grid
    // is anchored at `lo` -- the side's true start, not the clipped one -- so
    // panning moves the dashes with the geometry instead of sliding them along
    // the edge.
    auto dashed_side = [&](bool horizontal, float lo, float hi, float a, float b) {
        // Wholly off-screen across its short axis: nothing to walk at all.
        if (horizontal) {
            if (b < view.min_y || a > view.max_y) return;
        } else {
            if (b < view.min_x || a > view.max_x) return;
        }
        float clip_lo = std::max(lo, horizontal ? view.min_x : view.min_y);
        float clip_hi = std::min(hi, horizontal ? view.max_x : view.max_y);
        if (clip_hi <= clip_lo) return;
        // Dashes are laid on a fixed grid from `lo`; start at the last one that
        // can still reach clip_lo.
        double first = std::floor((double)(clip_lo - lo) / (double)period);
        for (double k = first;; k += 1.0) {
            float start = lo + (float)(k * (double)period);
            if (start > clip_hi) break;
            float end = std::min(start + dash, hi);
            if (end <= clip_lo) continue;
            if (end <= start) continue;
            if (horizontal) quad(std::max(start, clip_lo), a, end, b);
            else quad(a, std::max(start, clip_lo), b, end);
        }
    };

    for (size_t i = 0; i + 3 < g_highlight_boxes.size(); i += 4) {
        if (verts.size() >= kMaxHighlightVerts) break;
        float min_x = g_highlight_boxes[i], min_y = g_highlight_boxes[i + 1];
        float max_x = g_highlight_boxes[i + 2], max_y = g_highlight_boxes[i + 3];

        // Grow anything smaller than kHighlightMinPx on screen (a small cell
        // seen from across the die, or a zero-area one) about its own center, so
        // the outline is always drawn around a box thicker than the outline
        // itself and long enough on each side to show as more than one dash.
        float grow_x = (min_world - (max_x - min_x)) * 0.5f;
        if (grow_x > 0.0f) {
            min_x -= grow_x;
            max_x += grow_x;
        }
        float grow_y = (min_world - (max_y - min_y)) * 0.5f;
        if (grow_y > 0.0f) {
            min_y -= grow_y;
            max_y += grow_y;
        }

        // Outer/inner edges of the outline, straddling the box's boundary. The
        // horizontal sides run the full outer width so the corners are solid;
        // the vertical ones then only cover what's left between them.
        float ox0 = min_x - t, ox1 = max_x + t, oy0 = min_y - t, oy1 = max_y + t;
        float ix0 = min_x + t, ix1 = max_x - t, iy0 = min_y + t, iy1 = max_y - t;
        dashed_side(true, ox0, ox1, oy0, iy0);   // bottom
        dashed_side(true, ox0, ox1, iy1, oy1);   // top
        dashed_side(false, iy0, iy1, ox0, ix0);  // left
        dashed_side(false, iy0, iy1, ix1, ox1);  // right
    }
    if (verts.empty()) return;  // every box is off screen

    if (!g_highlight_vbo) glGenBuffers(1, &g_highlight_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, g_highlight_vbo);
    buffer_data_tracked(GL_ARRAY_BUFFER, g_highlight_vbo, (GLsizeiptr)(verts.size() * sizeof(float)),
                        verts.data(), GL_DYNAMIC_DRAW);
    glEnableVertexAttribArray(g_loc_position);
    glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
    glUniform4f(g_loc_color, g_highlight_color[0], g_highlight_color[1], g_highlight_color[2], 0.95f);
    glUniform1f(g_loc_use_hatch, 0.0f);
    glDrawArrays(GL_TRIANGLES, 0, (GLsizei)(verts.size() / 2));
}

// Defined just below draw_frame with the rest of the frame plumbing; declared
// here because draw_frame itself asks for the next frame while the Go to
// Coordinate flash is still fading.
void request_redraw();

// The Go to Coordinate crosshair, in the same blue as the selected-cell ring:
// both are the viewer pointing at a place you asked about, and the ruler's ink
// and the marker overlay's red already mean other things. Drawn last of the
// annotations so nothing hides the one thing the view was just moved for.
//
// Time-based rather than frame-based, since frames only happen when something
// asks for one -- draw_frame keeps requesting the next one while this is alive,
// and stops as soon as it expires (below), so the flash costs a couple of
// seconds of animation and nothing at all afterwards.
void draw_goto_flash(double now_ms) {
    if (g_goto_start_ms < 0.0) return;
    const double age = std::max(0.0, now_ms - g_goto_start_ms);
    if (age >= kGotoHoldMs + kGotoFadeMs) {
        g_goto_start_ms = -1.0;
        return;
    }
    const float fade =
        age <= kGotoHoldMs ? 1.0f : (float)(1.0 - (age - kGotoHoldMs) / kGotoFadeMs);

    const float gap = kGotoGapPx / g_zoom;
    const float arm = kGotoArmPx / g_zoom;
    const float r = kGotoRingPx / g_zoom;
    const float x = g_goto_x, y = g_goto_y;

    std::vector<float> verts = {
        x - arm, y, x - gap, y,  // west
        x + gap, y, x + arm, y,  // east
        x, y - arm, x, y - gap,  // south
        x, y + gap, x, y + arm,  // north
    };
    constexpr float kPi = 3.14159265358979323846f;
    for (int i = 0; i < kGotoRingSegments; i++) {
        const float a0 = 2.0f * kPi * (float)i / (float)kGotoRingSegments;
        const float a1 = 2.0f * kPi * (float)(i + 1) / (float)kGotoRingSegments;
        verts.insert(verts.end(), {x + r * std::cos(a0), y + r * std::sin(a0),
                                   x + r * std::cos(a1), y + r * std::sin(a1)});
    }

    if (!g_goto_vbo) glGenBuffers(1, &g_goto_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, g_goto_vbo);
    buffer_data_tracked(GL_ARRAY_BUFFER, g_goto_vbo, (GLsizeiptr)(verts.size() * sizeof(float)),
                        verts.data(), GL_DYNAMIC_DRAW);
    glEnableVertexAttribArray(g_loc_position);
    glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
    glUniform4f(g_loc_color, g_highlight_color[0], g_highlight_color[1], g_highlight_color[2],
                0.95f * fade);
    glUniform1f(g_loc_use_hatch, 0.0f);
    glDrawArrays(GL_LINES, 0, (GLsizei)(verts.size() / 2));
}

bool draw_frame(double time, void* /*userData*/) {
    g_frame_requested = false;
    // `time` is the rAF timestamp (ms); the delta between consecutive frames
    // is the real end-to-end frame time while interaction keeps frames
    // coming. Gaps over 500ms are idle time between interactions, not
    // rendering -- skip those.
    if (g_last_frame_timestamp > 0.0) {
        double dt = time - g_last_frame_timestamp;
        if (dt > 0.0 && dt < 500.0) {
            g_frame_ms_ema = g_frame_ms_ema <= 0.0f ? (float)dt : g_frame_ms_ema * 0.8f + (float)dt * 0.2f;
        }
    }
    g_last_frame_timestamp = time;
    // Markers may load before the GDS finishes parsing -- keep drawing them
    // (and everything else) even with no layers yet.
    if (g_layers.empty() && !markers_present()) return false;

    glClearColor(g_bg_color[0], g_bg_color[1], g_bg_color[2], 1.0f);
    glClear(GL_COLOR_BUFFER_BIT);
    glBindVertexArray(g_vao);
    // Under everything: the grid program has no attributes of its own, so it
    // needs nothing from the VAO beyond it being bound (same as merge mode's
    // composite pass), and it leaves the program switched, which the layer
    // uniforms below immediately correct.
    draw_grid();
    glUseProgram(g_program);

    glUniform2f(g_loc_resolution, (float)g_canvas_width, (float)g_canvas_height);
    glUniform2f(g_loc_offset, g_pan_x, g_pan_y);
    glUniform1f(g_loc_zoom, g_zoom);

    const ViewRect view = current_view_rect();

    // No per-polygon or per-tile culling: every on-screen layer draws in
    // exactly one glDrawArrays (fill) + one glDrawElements (outline) call,
    // full stop. An earlier version tried to fall back to a per-polygon
    // culled draw loop when a layer was only partially on screen (i.e. most
    // zoom levels between "fit to window" and "zoomed in on a small area"),
    // but that fallback issued one draw call per remaining visible polygon
    // and was the actual bottleneck -- worse than just drawing everything
    // unconditionally. The only skip left is the layer-level bbox check
    // below, which is O(number of layers), not O(number of polygons).
    uint64_t frame_visible_polygons = 0;
    int frame_layers_drawn = 0;

    for (const LayerBuffer& layer : g_layers) {
        if (!layer.visible) continue;
        if (!bbox_intersects_view(layer.min_x, layer.max_x, layer.min_y, layer.max_y, view)) continue;

        frame_layers_drawn++;
        frame_visible_polygons += layer.polygon_count;

        if (g_merge_mode) {
            draw_layer_merged(layer);
            continue;
        }

        if (layer.fill_vbo && g_show_infill) {
            glBindBuffer(GL_ARRAY_BUFFER, layer.fill_vbo);
            glEnableVertexAttribArray(g_loc_position);
            glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
            glUniform4fv(g_loc_color, 1, layer.fill_color.data());
            glUniform1f(g_loc_use_hatch, 1.0f);
            glUniform1f(g_loc_pattern_type, layer.pattern_type);
            glUniform1f(g_loc_hatch_angle, layer.hatch_angle);
            glUniform1f(g_loc_hatch_spacing, kHatchSpacingPx);
            glUniform1f(g_loc_hatch_width, kHatchHalfWidthPx);
            // Fill vertices are triangles laid back-to-back with no
            // loop-closing constraint, so the whole layer draws correctly
            // in one shot -- no indices needed.
            glDrawArrays(GL_TRIANGLES, 0, layer.fill_vertex_count);
        }

        if (layer.outline_ebo) {
            glBindBuffer(GL_ARRAY_BUFFER, layer.outline_vbo);
            glEnableVertexAttribArray(g_loc_position);
            glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
            glUniform4fv(g_loc_color, 1, layer.frame_color.data());
            glUniform1f(g_loc_use_hatch, 0.0f);
            // outline_ebo holds every polygon's boundary as explicit edge
            // pairs (see upload_geometry), so this one glDrawElements call
            // draws every outline polygon on the layer. Each edge is its own
            // independent primitive, so unrelated polygons can't get
            // connected and no restart markers are needed.
            glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, layer.outline_ebo);
            glDrawElements(GL_LINES, layer.outline_index_count, GL_UNSIGNED_INT, 0);
        }

        // Reused cells: one unique unit shape drawn instance_count times,
        // each placed by a per-instance 2x3 affine read from instance_vbo
        // (see a_iCol0/a_iCol1/a_iTranslate in kVertexShaderSrc). The divisor
        // makes those attributes advance once per instance instead of once
        // per vertex; the arrays are disabled again after each batch so the
        // affine reverts to the identity generic value (set in init_gl) for
        // the non-instanced draws above/below.
        for (const InstancedBatch& batch : layer.instanced_batches) {
            enable_instance_attribs(batch.instance_vbo);

            if (batch.fill_vbo && g_show_infill) {
                glBindBuffer(GL_ARRAY_BUFFER, batch.fill_vbo);
                glEnableVertexAttribArray(g_loc_position);
                glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
                glUniform4fv(g_loc_color, 1, layer.fill_color.data());
                glUniform1f(g_loc_use_hatch, 1.0f);
                glUniform1f(g_loc_pattern_type, layer.pattern_type);
                glUniform1f(g_loc_hatch_angle, layer.hatch_angle);
                glUniform1f(g_loc_hatch_spacing, kHatchSpacingPx);
                glUniform1f(g_loc_hatch_width, kHatchHalfWidthPx);
                glDrawArraysInstanced(GL_TRIANGLES, 0, batch.fill_vertex_count, batch.instance_count);
            }

            if (batch.outline_ebo) {
                glBindBuffer(GL_ARRAY_BUFFER, batch.outline_vbo);
                glEnableVertexAttribArray(g_loc_position);
                glVertexAttribPointer(g_loc_position, 2, GL_FLOAT, GL_FALSE, 0, 0);
                glUniform4fv(g_loc_color, 1, layer.frame_color.data());
                glUniform1f(g_loc_use_hatch, 0.0f);
                glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, batch.outline_ebo);
                glDrawElementsInstanced(GL_LINES, batch.outline_index_count, GL_UNSIGNED_INT, 0,
                                        batch.instance_count);
            }

            disable_instance_attribs();
        }
    }
    draw_text();
    draw_markers();
    // Over the geometry and the marker overlay (it's an answer to a question
    // about the layout, so it can't be buried by it), under the ruler.
    draw_cell_highlight();
    draw_measure_line();
    draw_goto_flash(time);
    // The flash is the only thing here that changes without an input event, so
    // it -- and only it -- keeps the frames coming while it lasts.
    if (g_goto_start_ms >= 0.0) request_redraw();
    update_measure_labels();
    // Here rather than at each camera-moving entry point: the world coordinate
    // under a stationary pointer changes with every one of them (wheel zoom,
    // Reset View, a marker/cell row framing the view, a resize), and they all
    // end in a redraw. Pointer *moves* that leave the camera alone are the one
    // case this misses, so on_mousemove calls it directly as well.
    update_coord_readout();
    update_render_stats(frame_visible_polygons, frame_layers_drawn, (int)g_layers.size());
    return false;
}

// Redraw-on-demand, not a ticking loop: only called from handlers that
// actually change state (resize, new data, drag move, wheel, .lyp load).
void request_redraw() {
    if (!g_gl_ready || g_frame_requested) return;
    g_frame_requested = true;
    emscripten_request_animation_frame(draw_frame, nullptr);
}

void resize_canvas() {
    val window = val::global("window");
    int width = window["innerWidth"].as<int>();
    int height = window["innerHeight"].as<int>();
    g_canvas_width = width;
    g_canvas_height = height;

    val canvas = val::global("document").call<val>("getElementById", std::string("glCanvas"));
    canvas.set("width", width);
    canvas.set("height", height);

    glViewport(0, 0, width, height);

    // Keep merge mode's coverage mask at canvas size * g_mask_scale -- the
    // composite pass addresses a scale x scale block per canvas pixel (the
    // supersampling that anti-aliases merge mode).
    if (g_mask_tex) {
        GLint max_tex = 0;
        glGetIntegerv(GL_MAX_TEXTURE_SIZE, &max_tex);
        g_mask_scale = (2 * width <= max_tex && 2 * height <= max_tex) ? 2 : 1;
        glBindTexture(GL_TEXTURE_2D, g_mask_tex);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_R8, width * g_mask_scale, height * g_mask_scale, 0, GL_RED,
                     GL_UNSIGNED_BYTE, nullptr);
        // R8 is one byte per texel; the mask is allocated whether or not merge
        // mode is on, so this counts unconditionally (see g_mask_tex_bytes).
        g_mask_tex_bytes = (uint64_t)(width * g_mask_scale) * (uint64_t)(height * g_mask_scale);
        // Merge mode failing at the FBO level shows as a blank canvas with no
        // other symptom (the mask reads all-zero and the composite discards
        // everything) -- check loudly here instead. Never triggered on a
        // conformant WebGL2 impl; exists because an earlier MSAA-based mask
        // did exactly that silently.
        glBindFramebuffer(GL_FRAMEBUFFER, g_mask_fbo);
        GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
        GLenum err = glGetError();
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        if (status != GL_FRAMEBUFFER_COMPLETE || err != GL_NO_ERROR) {
            EM_ASM({ console.warn('[GDS] merge-mode mask FBO incomplete: status 0x' + $0.toString(16) +
                                  ', glGetError 0x' + $1.toString(16)); },
                   (int)status, (int)err);
        }
    }
    clamp_pan();
    update_scale_bar();
    request_redraw();
}

void clear_layers() {
    for (LayerBuffer& layer : g_layers) {
        if (layer.outline_vbo) delete_buffer_tracked(&layer.outline_vbo);
        if (layer.outline_ebo) delete_buffer_tracked(&layer.outline_ebo);
        if (layer.fill_vbo) delete_buffer_tracked(&layer.fill_vbo);
        for (InstancedBatch& batch : layer.instanced_batches) {
            if (batch.fill_vbo) delete_buffer_tracked(&batch.fill_vbo);
            if (batch.outline_vbo) delete_buffer_tracked(&batch.outline_vbo);
            if (batch.outline_ebo) delete_buffer_tracked(&batch.outline_ebo);
            if (batch.instance_vbo) delete_buffer_tracked(&batch.instance_vbo);
        }
    }
    g_layers.clear();
    // The outlines point at cells in the geometry that's going away. viewer.js
    // re-selects the same row after a reload (renderHierarchy) and so puts them
    // back; dropping them here is what stops a *different* file inheriting
    // rectangles drawn around nothing.
    g_highlight_boxes.clear();
    // Same reasoning for the Go to Coordinate crosshair: it marks a spot in the
    // file being replaced.
    g_goto_start_ms = -1.0;
    // The label ranges index into g_layers -- they can't outlive it.
    g_text_ranges.clear();
    g_total_labels = 0;
    g_labels_drawn = 0;
    g_text_dirty = true;
}

// A 2D affine map x' = a*x + b*y + tx, y' = c*x + d*y + ty. Used to track the
// accumulated transform down a reference tree without materializing
// geometry at every level (see collect_instanced) -- gdstk's own
// Reference::transform composes Reference structs directly, but we need to
// split a reference's transform into its linear part (mag/x_reflection/
// rotation) and translation part (origin) separately, since only the
// translation varies across one repeated reference's instances.
struct Affine2D {
    double a = 1.0, b = 0.0, c = 0.0, d = 1.0;
    double tx = 0.0, ty = 0.0;

    Vec2 apply_point(const Vec2& p) const { return {a * p.x + b * p.y + tx, c * p.x + d * p.y + ty}; }
    Vec2 apply_linear(const Vec2& p) const { return {a * p.x + b * p.y, c * p.x + d * p.y}; }
};

// Composes two affine maps so that the result's apply_point matches
// outer.apply_point(inner.apply_point(p)) for any point p.
Affine2D compose_affine(const Affine2D& outer, const Affine2D& inner) {
    Affine2D r;
    r.a = outer.a * inner.a + outer.b * inner.c;
    r.b = outer.a * inner.b + outer.b * inner.d;
    r.c = outer.c * inner.a + outer.d * inner.c;
    r.d = outer.c * inner.b + outer.d * inner.d;
    Vec2 t = outer.apply_point({inner.tx, inner.ty});
    r.tx = t.x;
    r.ty = t.y;
    return r;
}

// Linear-only part (magnification, x_reflection, rotation) of a Reference's
// own transform -- mirrors the per-point math in
// Reference::repeat_and_transform, minus the +origin/+offset translation
// term, which collect_instanced applies separately per instance.
Affine2D reference_linear_transform(const Reference* ref) {
    double mag = ref->magnification;
    double ca = cos(ref->rotation), sa = sin(ref->rotation);
    double sy = ref->x_reflection ? -1.0 : 1.0;
    Affine2D t;
    t.a = mag * ca;
    t.b = -mag * sy * sa;
    t.c = mag * sa;
    t.d = mag * sy * ca;
    return t;
}

void transform_points(Array<Vec2>& points, const Affine2D& t, bool with_translation) {
    for (uint64_t i = 0; i < points.count; i++) {
        points[i] = with_translation ? t.apply_point(points[i]) : t.apply_linear(points[i]);
    }
}

// The full transform (linear part + origin translation) a reference applies
// to its target cell's local coordinates. offset is the extra per-copy
// displacement from the reference's repetition (see get_offsets); (0,0) for a
// plain non-repeated reference.
Affine2D reference_placement(const Reference* ref, const Vec2& offset) {
    Affine2D t = reference_linear_transform(ref);
    t.tx = ref->origin.x + offset.x;
    t.ty = ref->origin.y + offset.y;
    return t;
}

// One reused cell's worth of geometry: a single "unit shape" in the cell's
// own local frame (see build_instance_templates) plus one per-instance 2x3
// affine mapping that unit shape into world space -- one entry per place the
// cell ends up drawn. The unit shape is triangulated/uploaded once regardless
// of how many instances there are, which is the whole point: a cell placed
// 800k times (as one AREF or 800k separate SREFs) costs one shape plus 800k
// cheap affines instead of 800k full copies.
// One label picked up during the flatten, with its origin already in world
// space. Collected into per-tag buckets alongside the polygons (a label lives
// on a (layer, texttype) pair, which shares the Tag encoding with
// (layer, datatype)) so labels inherit the color and visibility of the layer
// they belong to.
struct CollectedLabel {
    double x, y;
    uint8_t anchor;
    std::string text;
};

// Ceiling on how many labels one layout contributes. A label costs its text
// plus ~40 bytes and is kept for the life of the view (see TextLabel), and a
// cell holding a few pins placed 100k times can produce millions of them --
// well past the point where any of them is readable. Collection stops here
// rather than growing without bound; the viewer logs that it happened.
constexpr uint64_t kMaxLabels = 200000;

struct LabelSink {
    std::unordered_map<uint64_t, std::vector<CollectedLabel>> by_tag;
    uint64_t count = 0;
    bool capped = false;

    void add(uint64_t tag, double x, double y, uint8_t anchor, const char* text) {
        // Empty text draws nothing -- dropping it here keeps it from creating
        // a layer entry (and a sidebar row) of its own.
        if (text == nullptr || text[0] == '\0') return;
        if (count >= kMaxLabels) {
            capped = true;
            return;
        }
        by_tag[tag].push_back({x, y, anchor, std::string(text)});
        count++;
    }
};

struct InstanceGroupPolys {
    // Keyed by gdstk Tag (layer + datatype), not layer number -- see LayerBuffer.
    std::unordered_map<uint64_t, std::vector<Polygon*>> by_layer_unit;
    std::vector<Affine2D> instances;
};

// Fully flattens cell's whole subtree into concrete polygons in the cell's
// own local frame (every reference and repetition expanded, no instancing) --
// the unit shape baked once per instanced cell. Any reuse *inside* this
// subtree is materialized here rather than sub-instanced, which keeps GPU
// instancing to a single level (an instanced cell's template may itself
// contain other instanced cells, but along any path collect_instanced stops
// at the outermost one -- see its comment -- so nothing is double-drawn).
void build_cell_template(Cell* cell, std::unordered_map<uint64_t, std::vector<Polygon*>>& out_by_layer) {
    Array<Polygon*> polygons = {};
    cell->get_polygons(true, true, -1, false, 0, polygons);
    for (uint64_t i = 0; i < polygons.count; i++) {
        Polygon* poly = polygons[i];
        out_by_layer[poly->tag].push_back(poly);
    }
    polygons.clear();
}

// Number of expanded instances of each cell across the whole rendered design
// -- i.e. how many times its own geometry would appear if the hierarchy were
// fully flattened. Used to decide which cells are worth GPU-instancing (see
// choose_instanced_cells): a cell placed thousands of times is; a cell placed
// once or twice isn't (instancing it would only add draw calls). Computed as
// a saturating double because the true count can overflow any integer for
// deep arrayed hierarchies -- and overflowing is itself a strong "instance
// this" signal, so saturation at the threshold is harmless.
constexpr double kInstanceCountCap = 1e18;

// A cell is GPU-instanced when it's placed at least this many times. Below
// this, flattening the few copies into the static per-layer buffers is
// cheaper than the extra per-batch draw calls instancing would add.
constexpr double kInstanceThreshold = 8.0;

// Fills counts[C] = expanded instance count of C, via memoized recursion over
// the reference DAG (GDS references never form a cycle). roots are the cells
// rendered directly at top level (each contributes 1); every reference
// multiplies its target's count by the parent's count times the reference's
// repetition count.
double compute_instance_count(Cell* cell, const std::unordered_map<Cell*, double>& base_counts,
                              std::unordered_map<Cell*, double>& memo,
                              std::unordered_map<Cell*, int>& visiting);

double count_contributions_from_parents(Cell* cell, const std::unordered_map<Cell*, double>& base_counts,
                                         std::unordered_map<Cell*, double>& memo,
                                         std::unordered_map<Cell*, int>& visiting,
                                         const std::unordered_map<Cell*, std::vector<std::pair<Cell*, double>>>& preds) {
    double total = base_counts.count(cell) ? base_counts.at(cell) : 0.0;
    auto it = preds.find(cell);
    if (it != preds.end()) {
        for (const auto& pr : it->second) {
            double parent_count = compute_instance_count(pr.first, base_counts, memo, visiting);
            total += parent_count * pr.second;
            if (total >= kInstanceCountCap) return kInstanceCountCap;
        }
    }
    return total;
}

// preds is captured via a thread-local-ish shim below; see choose_instanced_cells.
const std::unordered_map<Cell*, std::vector<std::pair<Cell*, double>>>* g_preds_for_count = nullptr;

double compute_instance_count(Cell* cell, const std::unordered_map<Cell*, double>& base_counts,
                              std::unordered_map<Cell*, double>& memo,
                              std::unordered_map<Cell*, int>& visiting) {
    auto m = memo.find(cell);
    if (m != memo.end()) return m->second;
    // Guard against a malformed cyclic library (shouldn't happen in valid
    // GDS): treat a cell currently being computed as contributing nothing on
    // the back-edge rather than recursing forever.
    if (visiting[cell]) return 0.0;
    visiting[cell] = 1;
    double total = count_contributions_from_parents(cell, base_counts, memo, visiting, *g_preds_for_count);
    visiting[cell] = 0;
    memo[cell] = total;
    return total;
}

// Picks the set of cells to GPU-instance: those placed >= kInstanceThreshold
// times across the design. Builds the reference DAG's reverse adjacency
// (child -> [(parent, repetition_count)]) once, then evaluates
// compute_instance_count for every cell.
std::unordered_map<Cell*, bool> choose_instanced_cells(Library& lib,
                                                       const std::unordered_map<Cell*, double>& base_counts) {
    std::unordered_map<Cell*, std::vector<std::pair<Cell*, double>>> preds;
    for (uint64_t i = 0; i < lib.cell_array.count; i++) {
        Cell* parent = lib.cell_array[i];
        for (uint64_t r = 0; r < parent->reference_array.count; r++) {
            Reference* ref = parent->reference_array[r];
            if (ref->type != ReferenceType::Cell || ref->cell == nullptr) continue;
            // get_count() returns 0 for a plain (non-arrayed) reference; that
            // reference still places one copy, so floor it at 1.
            uint64_t rep_count = ref->repetition.get_count();
            double rep = rep_count > 0 ? (double)rep_count : 1.0;
            preds[ref->cell].push_back({parent, rep});
        }
    }
    g_preds_for_count = &preds;

    std::unordered_map<Cell*, double> memo;
    std::unordered_map<Cell*, int> visiting;
    std::unordered_map<Cell*, bool> instanced;
    for (uint64_t i = 0; i < lib.cell_array.count; i++) {
        Cell* cell = lib.cell_array[i];
        double count = compute_instance_count(cell, base_counts, memo, visiting);
        instanced[cell] = count >= kInstanceThreshold;
    }
    g_preds_for_count = nullptr;
    return instanced;
}

// Walks cell's reference tree under the accumulated transform `current`,
// splitting geometry into:
//   * by_layer_static -- plain per-layer polygons already in world space, for
//     cells not worth instancing (placed only a handful of times), same as a
//     full flatten would produce; and
//   * groups -- one InstanceGroupPolys per instanced cell (see `instanced`),
//     accumulating a per-instance affine each time that cell is placed.
// Descent stops at the first instanced cell on any path (its whole subtree is
// captured by its template, built separately), so no polygon is emitted
// twice. templates_needed collects which cells actually got instanced so the
// caller only builds templates for those. Labels are collected into `labels`
// the same way the static geometry is -- but only for cells this walk actually
// descends into; an instanced cell's labels are expanded per instance by the
// caller, since the walk stops there.
void collect_instanced(Cell* cell, const Affine2D& current,
                       const std::unordered_map<Cell*, bool>& instanced,
                       std::unordered_map<uint64_t, std::vector<Polygon*>>& by_layer_static,
                       std::unordered_map<Cell*, InstanceGroupPolys>& groups, LabelSink& labels) {
    // This cell's own polygons/paths only (depth=0); apply_repetitions still
    // expands any repetition attached directly to a polygon/path (a rarer
    // feature distinct from a Reference's repetition), left as static
    // geometry.
    Array<Polygon*> own_polygons = {};
    cell->get_polygons(true, true, 0, false, 0, own_polygons);
    for (uint64_t i = 0; i < own_polygons.count; i++) {
        Polygon* poly = own_polygons[i];
        transform_points(poly->point_array, current, /*with_translation=*/true);
        by_layer_static[poly->tag].push_back(poly);
    }
    own_polygons.clear();

    // This cell's own labels (depth=0, repetitions expanded exactly like the
    // polygons above), moved into world space. get_labels hands back copies,
    // so each one is freed here after its origin/text have been taken.
    Array<Label*> own_labels = {};
    cell->get_labels(true, 0, false, 0, own_labels);
    for (uint64_t i = 0; i < own_labels.count; i++) {
        Label* label = own_labels[i];
        Vec2 p = current.apply_point(label->origin);
        labels.add(label->tag, p.x, p.y, (uint8_t)label->anchor, label->text);
        label->clear();
        free_allocation(label);
    }
    own_labels.clear();

    for (uint64_t i = 0; i < cell->reference_array.count; i++) {
        Reference* ref = cell->reference_array[i];
        if (ref->type != ReferenceType::Cell || ref->cell == nullptr) continue;

        // One (0,0) offset for a plain reference, one per copy for an AREF.
        Vec2 zero = {0, 0};
        Array<Vec2> offsets = {};
        if (ref->repetition.type != RepetitionType::None) {
            ref->repetition.get_offsets(offsets);
        } else {
            offsets.count = 1;
            offsets.items = &zero;
        }

        auto it = instanced.find(ref->cell);
        bool is_instanced = it != instanced.end() && it->second;

        for (uint64_t k = 0; k < offsets.count; k++) {
            Affine2D placement = compose_affine(current, reference_placement(ref, offsets[k]));
            if (is_instanced) {
                groups[ref->cell].instances.push_back(placement);
            } else {
                collect_instanced(ref->cell, placement, instanced, by_layer_static, groups, labels);
            }
        }

        if (ref->repetition.type != RepetitionType::None) offsets.clear();
    }
}

// Fresh JS-owned Float32Array copied out of a wasm-heap vector -- mirrors
// bindings.cpp's to_float64_array. The returned array doesn't alias wasm
// memory, so it's safe for a caller (e.g. the Worker script) to hold onto or
// postMessage-transfer after this call returns.
val to_float32_array(const std::vector<float>& data) {
    val array = val::global("Float32Array").new_(data.size());
    array.call<void>("set", typed_memory_view(data.size(), data.data()));
    return array;
}

val to_uint8_array(const std::vector<uint8_t>& data) {
    val array = val::global("Uint8Array").new_(data.size());
    array.call<void>("set", typed_memory_view(data.size(), data.data()));
    return array;
}

val to_uint32_array(const std::vector<uint32_t>& data) {
    val array = val::global("Uint32Array").new_(data.size());
    array.call<void>("set", typed_memory_view(data.size(), data.data()));
    return array;
}

// Fire-and-forget progress ping: self.postMessage in the Worker that runs
// parseGdsToLayers (the normal case), window.postMessage on the main thread
// otherwise. Workers deliver postMessage to the other thread as soon as it's
// called, not when the sender goes idle, so the listener sees these
// near-real-time even though this function is called from deep inside a
// single long synchronous C++ call.
void report_progress(const char* phase, uint64_t current, uint64_t total) {
    EM_ASM(
        {
            if (typeof postMessage === 'function') {
                postMessage({type : 'gdsProgress', phase : UTF8ToString($0), current : $1, total : $2});
            }
        },
        phase, (double)current, (double)total);
}

// ---- Cell hierarchy (the viewer's left-hand tree) ----
// Structure only: each cell's name, which cells it places, and where those
// placements land. No geometry crosses into JS here -- what gets drawn is
// still the flattened per-layer buffers, and the tree exists to navigate the
// design (click a cell, frame it) rather than to render it. Read off the
// Library before the flatten, since lib.free_all() takes the reference arrays
// with it.

// Ceiling on how many cells the tree describes. Every cell becomes a JS
// object carrying its own child list, so a machine-generated library with a
// million single-shape cells would spend more memory describing the design
// than drawing it -- and a tree that large is not something anyone browses.
// Past this the tree is dropped and the panel says why.
constexpr size_t kMaxHierarchyCells = 50000;

// Depth ceiling for the bbox recursion below. References form a DAG in any
// valid file and the memo makes even a wide one cheap; `visiting` catches a
// malformed file that closes a loop, and this catches a pathological but
// acyclic depth before the stack does.
constexpr int kMaxHierarchyDepth = 256;

// How many individual placements one tree row carries transforms for, so the
// viewer can outline each copy of a selected cell separately rather than
// drawing one box around the lot (see setCellHighlight). Past this the row
// carries none and falls back to the single spanning box: 40,000 dashed
// rectangles is not a picture of anything, and an *arbitrary 1,024 of them*
// would be a lie -- it would look like the cell is only in the part of the
// array we happened to keep.
constexpr uint64_t kMaxRowPlacements = 1024;

// ...and a library-wide ceiling on the same thing, since the per-row cap alone
// says nothing about how many rows there are. A generated library can hold tens
// of thousands of cells each placing several others hundreds of times, and this
// is per-placement data -- the one part of the tree that isn't bounded by the
// cell count. Rows built after the budget runs out fall back to the spanning
// box exactly as an over-cap row does.
constexpr uint64_t kMaxHierarchyPlacements = 200000;

// min > max means "nothing in it", the same sentinel parseGdsToLayers uses for
// the design bbox: an empty cell is a real thing in a layout (a placeholder,
// or one holding only references to empty cells) and has no box to frame.
struct HierBox {
    double min_x = HUGE_VAL, max_x = -HUGE_VAL, min_y = HUGE_VAL, max_y = -HUGE_VAL;

    bool valid() const { return min_x <= max_x; }

    void add(const Vec2& p) {
        min_x = std::min(min_x, p.x);
        max_x = std::max(max_x, p.x);
        min_y = std::min(min_y, p.y);
        max_y = std::max(max_y, p.y);
    }

    void add(const HierBox& other) {
        if (!other.valid()) return;
        add(Vec2{other.min_x, other.min_y});
        add(Vec2{other.max_x, other.max_y});
    }
};

val hier_box_to_val(const HierBox& box) {
    if (!box.valid()) return val::null();
    val out = val::object();
    out.set("minX", box.min_x);
    out.set("maxX", box.max_x);
    out.set("minY", box.min_y);
    out.set("maxY", box.max_y);
    return out;
}

// A box widened to cover every copy a repetition makes of it. Only the
// translation varies across the copies, so the box is slid to the repetition's
// extreme offsets -- get_extrema rather than get_offsets, because a single
// repetition can hold millions of copies and only its corners can move the
// box. A degenerate repetition (zero rows or columns) yields no extrema and so
// no box, matching a flatten that places nothing for it.
HierBox spread_repetition(const HierBox& box, const Repetition& repetition) {
    if (!box.valid() || repetition.type == RepetitionType::None) return box;

    Array<Vec2> extrema = {};
    repetition.get_extrema(extrema);
    HierBox out;
    for (uint64_t i = 0; i < extrema.count; i++) {
        out.add(Vec2{box.min_x + extrema[i].x, box.min_y + extrema[i].y});
        out.add(Vec2{box.max_x + extrema[i].x, box.max_y + extrema[i].y});
    }
    extrema.clear();
    return out;
}

// Extent of a cell's own geometry -- its polygons, paths and label origins,
// each spread over its own repetition if it has one, and nothing it references
// -- in the cell's own frame. Label origins count, matching how
// parseGdsToLayers frames the design: a cell holding only pin text still has a
// place to be.
//
// Deliberately walks the cell's arrays rather than calling get_polygons, whose
// result is a freshly allocated copy of every polygon: a flat top cell holds
// millions of them, and this runs *before* the flatten, so a second copy of the
// largest cell in the design is the last thing to spend the heap on.
HierBox own_geometry_box(Cell* cell) {
    HierBox box;

    for (uint64_t i = 0; i < cell->polygon_array.count; i++) {
        Polygon* poly = cell->polygon_array[i];
        HierBox shape;
        for (uint64_t k = 0; k < poly->point_array.count; k++) shape.add(poly->point_array[k]);
        box.add(spread_repetition(shape, poly->repetition));
    }

    for (uint64_t i = 0; i < cell->label_array.count; i++) {
        Label* label = cell->label_array[i];
        HierBox origin;
        origin.add(label->origin);
        box.add(spread_repetition(origin, label->repetition));
    }

    // Paths are the one thing that has to be built to be measured -- gdstk
    // gives them no bounding box of their own -- so each is converted on its
    // own and freed before the next, which holds this to one path's worth of
    // polygons rather than the whole cell's. to_polygons copies the path's
    // repetition onto each polygon it produces, which is what spreads it here.
    Array<Polygon*> path_polygons = {};
    auto measure_path_polygons = [&box, &path_polygons]() {
        for (uint64_t k = 0; k < path_polygons.count; k++) {
            Polygon* poly = path_polygons[k];
            HierBox shape;
            for (uint64_t p = 0; p < poly->point_array.count; p++) shape.add(poly->point_array[p]);
            box.add(spread_repetition(shape, poly->repetition));
            poly->clear();
            free_allocation(poly);
        }
        path_polygons.count = 0;
    };
    for (uint64_t i = 0; i < cell->flexpath_array.count; i++) {
        cell->flexpath_array[i]->to_polygons(false, 0, path_polygons);
        measure_path_polygons();
    }
    for (uint64_t i = 0; i < cell->robustpath_array.count; i++) {
        cell->robustpath_array[i]->to_polygons(false, 0, path_polygons);
        measure_path_polygons();
    }
    path_polygons.clear();

    return box;
}

// Where one reference puts its target, in the *parent's* frame, covering every
// copy of an arrayed reference. Mapping the target's box (rather than its real
// outline) through a non-90° rotation over-estimates, which is harmless for
// framing a camera on it.
HierBox placed_box(const Reference* ref, const HierBox& target) {
    if (!target.valid()) return HierBox{};

    // The linear part -- magnification, mirror, rotation -- is shared by every
    // copy; the origin and the repetition only translate.
    Affine2D linear = reference_linear_transform(ref);
    HierBox mapped;
    const Vec2 corners[4] = {{target.min_x, target.min_y},
                             {target.max_x, target.min_y},
                             {target.min_x, target.max_y},
                             {target.max_x, target.max_y}};
    for (const Vec2& corner : corners) mapped.add(linear.apply_linear(corner));

    HierBox placed;
    placed.add(Vec2{mapped.min_x + ref->origin.x, mapped.min_y + ref->origin.y});
    placed.add(Vec2{mapped.max_x + ref->origin.x, mapped.max_y + ref->origin.y});
    return spread_repetition(placed, ref->repetition);
}

// Full extent of a cell -- its own geometry plus everything it places,
// recursively -- in its own frame. Memoized per cell, so a cell shared by a
// thousand parents is measured once.
HierBox cell_box(Cell* cell, std::unordered_map<Cell*, HierBox>& memo, std::unordered_map<Cell*, bool>& visiting,
                 int depth) {
    auto found = memo.find(cell);
    if (found != memo.end()) return found->second;
    if (depth >= kMaxHierarchyDepth || visiting[cell]) return HierBox{};

    visiting[cell] = true;
    HierBox box = own_geometry_box(cell);
    for (uint64_t i = 0; i < cell->reference_array.count; i++) {
        Reference* ref = cell->reference_array[i];
        if (ref->type != ReferenceType::Cell || ref->cell == nullptr) continue;
        box.add(placed_box(ref, cell_box(ref->cell, memo, visiting, depth + 1)));
    }
    visiting[cell] = false;

    memo[cell] = box;
    return box;
}

// One row of the tree's child list: every reference from a parent cell to the
// same target collapsed into a single entry. That's what keeps this a *cell*
// tree -- a memory cell placed 40k times is one row saying "×40000", not 40k
// rows -- and it means the entry needs several boxes' worth of information:
// `box` spans all those placements (what clicking the row frames), `first` is
// the transform of the first one alone (what a deeper node composes onto, so
// expanding a repeated cell follows one copy of it), and `placements` holds
// every placement's transform (6 doubles each, laid out like Affine2D) so the
// viewer can outline the copies one by one instead of drawing a box around all
// of them. Over kMaxRowPlacements copies -- or once the library-wide budget is
// spent -- `placements` is emptied and `capped` set: half an array's worth of
// outlines would misrepresent where the cell actually is, so the row goes back
// to the single spanning box.
struct HierChild {
    double count = 0;
    HierBox box;
    Affine2D first;
    bool have_first = false;
    std::vector<double> placements;
    bool capped = false;
};

// Placement transforms go over as a Float64Array rather than a plain array of
// objects: it's one bulk copy instead of thousands of JS property writes, and
// float32 would quantize a translation on a full-reticle coordinate (~1e5 µm)
// to about 10nm, which is visible as a nudged outline on a small cell.
val to_float64_array(const std::vector<double>& data) {
    val array = val::global("Float64Array").new_(data.size());
    array.call<void>("set", typed_memory_view(data.size(), data.data()));
    return array;
}

val hier_xform_to_val(const Affine2D& t) {
    val out = val::array();
    out.call<void>("push", t.a);
    out.call<void>("push", t.b);
    out.call<void>("push", t.c);
    out.call<void>("push", t.d);
    out.call<void>("push", t.tx);
    out.call<void>("push", t.ty);
    return out;
}

// Builds the whole tree payload: a flat cells[] array (children reference each
// other by index into it, so a shared cell is described once however many
// parents place it) plus the indices of the cells rendered at top level.
val build_hierarchy(Library& lib, const std::vector<Cell*>& roots) {
    val out = val::object();
    out.set("cellCount", (double)lib.cell_array.count);
    out.set("cells", val::array());
    out.set("roots", val::array());

    if (lib.cell_array.count > kMaxHierarchyCells) {
        out.set("omitted", true);
        return out;
    }
    out.set("omitted", false);

    std::unordered_map<Cell*, int> cell_index;
    cell_index.reserve(lib.cell_array.count * 2);
    for (uint64_t i = 0; i < lib.cell_array.count; i++) cell_index[lib.cell_array[i]] = (int)i;

    // Every cell's extent, bottom-up over the shared memo -- one pass over the
    // library's own (unflattened) geometry, so this costs a fraction of the
    // flatten that follows. Progress is reported in ~100 steps rather than per
    // cell: each report is a postMessage, and 50k of them cost more than the
    // work they describe.
    std::unordered_map<Cell*, HierBox> boxes;
    std::unordered_map<Cell*, bool> visiting;
    uint64_t report_every = lib.cell_array.count / 100 + 1;
    for (uint64_t i = 0; i < lib.cell_array.count; i++) {
        cell_box(lib.cell_array[i], boxes, visiting, 0);
        if ((i + 1) % report_every == 0) report_progress("hierarchy", i + 1, lib.cell_array.count);
    }
    report_progress("hierarchy", lib.cell_array.count, lib.cell_array.count);

    // Library-wide placement-transform budget, spent by the rows below in the
    // order the cells appear in the file (see kMaxHierarchyPlacements).
    uint64_t placements_left = kMaxHierarchyPlacements;

    val cells = val::array();
    for (uint64_t i = 0; i < lib.cell_array.count; i++) {
        Cell* cell = lib.cell_array[i];

        // Collapse this cell's references per target, keeping first-encounter
        // order so the tree reads in the order the file placed things.
        std::vector<Cell*> child_order;
        std::unordered_map<Cell*, HierChild> children;
        for (uint64_t r = 0; r < cell->reference_array.count; r++) {
            Reference* ref = cell->reference_array[r];
            if (ref->type != ReferenceType::Cell || ref->cell == nullptr) continue;
            if (cell_index.find(ref->cell) == cell_index.end()) continue;
            // get_count() is 0 for a plain reference, which still places one
            // copy (and 0 for a degenerate 0-column array, which places none
            // -- the flatten skips those too, so skip them here).
            uint64_t rep_count = ref->repetition.get_count();
            if (rep_count == 0 && ref->repetition.type != RepetitionType::None) continue;

            auto found = children.find(ref->cell);
            if (found == children.end()) {
                child_order.push_back(ref->cell);
                found = children.emplace(ref->cell, HierChild{}).first;
            }
            HierChild& child = found->second;
            uint64_t places = rep_count > 0 ? rep_count : 1;
            child.count += (double)places;
            child.box.add(placed_box(ref, boxes[ref->cell]));
            if (!child.have_first) {
                // A repetition's first copy is always its (0,0) offset (see
                // get_offsets), so the first placement is the reference's own
                // transform.
                child.first = reference_placement(ref, Vec2{0, 0});
                child.have_first = true;
            }

            // One transform per copy, for the viewer's per-placement outlines.
            // Both ceilings are checked *before* get_offsets, which materializes
            // the whole offset array: a single AREF can hold millions of copies,
            // and the point of the caps is not to build that list at all.
            if (child.capped) continue;
            uint64_t held = (uint64_t)(child.placements.size() / 6);
            if (held + places > kMaxRowPlacements || places > placements_left) {
                child.capped = true;
                placements_left += held;  // hand the row's share back
                child.placements.clear();
                child.placements.shrink_to_fit();
                continue;
            }
            placements_left -= places;
            child.placements.reserve(child.placements.size() + places * 6);

            Vec2 zero = {0, 0};
            Array<Vec2> offsets = {};
            if (ref->repetition.type != RepetitionType::None) {
                ref->repetition.get_offsets(offsets);
            } else {
                // Borrowed storage for the single-copy case -- cleared below
                // only in the repetition branch, exactly as collect_instanced
                // does it.
                offsets.count = 1;
                offsets.items = &zero;
            }
            for (uint64_t k = 0; k < offsets.count; k++) {
                Affine2D t = reference_placement(ref, offsets[k]);
                const double v[6] = {t.a, t.b, t.c, t.d, t.tx, t.ty};
                child.placements.insert(child.placements.end(), v, v + 6);
            }
            if (ref->repetition.type != RepetitionType::None) offsets.clear();
        }

        val refs = val::array();
        for (Cell* child_cell : child_order) {
            const HierChild& child = children[child_cell];
            val entry = val::object();
            entry.set("cell", cell_index[child_cell]);
            entry.set("count", child.count);
            entry.set("bbox", hier_box_to_val(child.box));
            entry.set("xform", hier_xform_to_val(child.first));
            // Null rather than an empty array when capped, so the viewer's test
            // is "did I get the placements or not" and can't half-succeed. A row
            // with a single placement carries none either: `box` already *is*
            // that placement's box, so an array saying the same thing would be
            // one more object per row of the tree for nothing.
            bool one_placement = child.count <= 1.0;
            entry.set("placements", (child.placements.empty() || one_placement)
                                        ? val::null()
                                        : to_float64_array(child.placements));
            refs.call<void>("push", entry);
        }

        val cell_entry = val::object();
        cell_entry.set("name", std::string(cell->name ? cell->name : ""));
        // Own elements only -- the tree shows what each cell contributes
        // itself, with its children listed right below it.
        cell_entry.set("polygons", (double)(cell->polygon_array.count + cell->flexpath_array.count +
                                            cell->robustpath_array.count));
        cell_entry.set("labels", (double)cell->label_array.count);
        cell_entry.set("bbox", hier_box_to_val(boxes[cell]));
        cell_entry.set("refs", refs);
        cells.call<void>("push", cell_entry);
    }

    val root_indices = val::array();
    for (Cell* root : roots) {
        auto found = cell_index.find(root);
        if (found != cell_index.end()) root_indices.call<void>("push", found->second);
    }

    out.set("cells", cells);
    out.set("roots", root_indices);
    return out;
}

bool on_mousedown(int /*eventType*/, const EmscriptenMouseEvent* e, void* /*userData*/) {
    // The right button opens the canvas menu (see the contextmenu handler in
    // viewer.js) and does nothing else: without this it would also arm a pan,
    // and in measure mode it would drop a ruler point under the menu that just
    // appeared. Not consumed (false) -- the browser still has to raise the
    // contextmenu event that the menu is listening for.
    if (e->button == 2) return false;
    if (g_measure_mode) {
        // Click-click measurement: first click anchors the start point (the
        // line then tracks the cursor via on_mousemove), second click finishes
        // the ruler into g_measurements. A further click starts another one --
        // the finished ones stay up.
        float wx, wy;
        resolve_measure_point(e, g_measure_pending, wx, wy);
        if (!g_measure_pending) {
            g_measure_x0 = wx;
            g_measure_y0 = wy;
            g_measure_x1 = wx;
            g_measure_y1 = wy;
            g_measure_pending = true;
        } else {
            g_measurements.push_back({g_measure_x0, g_measure_y0, wx, wy});
            g_measure_pending = false;
        }
        request_redraw();
        return true;
    }
    g_dragging = true;
    g_last_mouse_x = e->clientX;
    g_last_mouse_y = e->clientY;
    return true;
}

bool on_mousemove(int /*eventType*/, const EmscriptenMouseEvent* e, void* /*userData*/) {
    g_cursor_x = (float)e->targetX;
    g_cursor_y = (float)e->targetY;
    g_cursor_inside = true;
    update_coord_readout();
    // In measure mode the cursor is always aiming at something, whether or not
    // a ruler is half-placed: resolving the point every move is what puts the
    // snap indicator under the cursor before the first click rather than after
    // it. Dragging never pans here -- on_mousedown doesn't arm it in this mode.
    if (g_measure_mode) {
        float wx, wy;
        resolve_measure_point(e, g_measure_pending, wx, wy);
        if (g_measure_pending) {
            g_measure_x1 = wx;
            g_measure_y1 = wy;
        }
        request_redraw();
        return true;
    }
    if (!g_dragging) return false;
    int dx = e->clientX - g_last_mouse_x;
    int dy = e->clientY - g_last_mouse_y;
    g_pan_x -= dx / g_zoom;
    g_pan_y += dy / g_zoom;
    clamp_pan();
    g_last_mouse_x = e->clientX;
    g_last_mouse_y = e->clientY;
    request_redraw();
    return true;
}

bool on_mouseup(int /*eventType*/, const EmscriptenMouseEvent* /*e*/, void* /*userData*/) {
    g_dragging = false;
    return true;
}

// The pointer readout is only true while the pointer is over the canvas --
// leaving it would otherwise freeze the last coordinate on screen as if it were
// still live.
bool on_mouseleave(int /*eventType*/, const EmscriptenMouseEvent* /*e*/, void* /*userData*/) {
    g_cursor_inside = false;
    update_coord_readout();
    return false;
}

// How much one wheel notch -- one detent of a stepped mouse wheel -- zooms.
constexpr double kZoomPerNotch = 1.10;

// What one notch is worth in each of the units a wheel event can report in.
// 100 pixels and 3 lines per notch are the de facto conventions browsers
// follow; a page is taken as a notch on its own.
constexpr double kPixelsPerNotch = 100.0;
constexpr double kLinesPerNotch = 3.0;

// Ceiling on one event's worth of notches. Free-spinning wheels and momentum
// scrolling can deliver a single delta worth many of them, and without a cap
// one stray event crosses decades of zoom in a frame.
constexpr double kMaxNotchesPerEvent = 4.0;

// Zooms around the cursor rather than the view center: the world point
// currently under the mouse (computed from the vertex shader's inverse --
// see kVertexShaderSrc) is held fixed on screen across the zoom change by
// solving for the new pan that keeps it there.
//
// The zoom step is proportional to how far the event says the wheel turned,
// not one fixed step per event. A stepped mouse wheel sends one event per
// notch, so those are unaffected; a trackpad (or any smooth-scrolling wheel)
// sends a stream of small deltas instead, and charging each of them a full
// notch made one two-finger swipe zoom by orders of magnitude.
bool on_wheel(int /*eventType*/, const EmscriptenWheelEvent* e, void* /*userData*/) {
    double notches = 0.0;
    switch (e->deltaMode) {
        case DOM_DELTA_LINE: notches = e->deltaY / kLinesPerNotch; break;
        case DOM_DELTA_PAGE: notches = e->deltaY; break;
        default: notches = e->deltaY / kPixelsPerNotch; break;  // DOM_DELTA_PIXEL
    }
    notches = std::max(-kMaxNotchesPerEvent, std::min(kMaxNotchesPerEvent, notches));

    float old_zoom = g_zoom;
    // deltaY > 0 is a scroll away from the viewer, which zooms out.
    float factor = (float)std::pow(kZoomPerNotch, -notches);
    float new_zoom = clamp_zoom_value(old_zoom * factor);
    if (new_zoom != old_zoom) {
        float px = (float)e->mouse.targetX - (float)g_canvas_width * 0.5f;
        float py = (float)g_canvas_height * 0.5f - (float)e->mouse.targetY;
        float world_x = g_pan_x + px / old_zoom;
        float world_y = g_pan_y + py / old_zoom;
        g_zoom = new_zoom;
        g_pan_x = world_x - px / new_zoom;
        g_pan_y = world_y - py / new_zoom;
        clamp_pan();
    }
    update_scale_bar();
    // The pointer hasn't moved, but the world under it has. The readout itself
    // is refreshed by the redraw below (see draw_frame), which is what covers
    // every other camera move too -- this only keeps the anchor current.
    g_cursor_x = (float)e->mouse.targetX;
    g_cursor_y = (float)e->mouse.targetY;
    g_cursor_inside = true;
    request_redraw();
    return true;
}

void reset_view() {
    g_zoom = g_fit_zoom;
    g_pan_x = g_fit_pan_x;
    g_pan_y = g_fit_pan_y;
    update_scale_bar();
    request_redraw();
}

// Camera read/write, used to reload a layout in place (see the
// "newer version on disk" banner in viewer.js). A reload runs the whole
// parse -> uploadLayers path again, and uploadLayers always re-frames the
// view on the new design's bbox -- fine on first open, but it would throw
// away wherever the user was looking on every re-read, which is exactly the
// thing you don't want while a generator rewrites the file underneath you.
// Capturing before and restoring after keeps the view put.
val getCamera() {
    val out = val::object();
    out.set("zoom", g_zoom);
    out.set("panX", g_pan_x);
    out.set("panY", g_pan_y);
    return out;
}

// Clamped against the *new* design's fit zoom and bbox, not the old one --
// if the layout shrank drastically between reads, the old camera can sit
// outside what the new geometry allows, and the clamps are what keep the
// restore from parking the view in empty space.
void setCamera(float zoom, float pan_x, float pan_y) {
    if (!(zoom > 0.0f)) return;  // also rejects NaN
    g_zoom = clamp_zoom_value(zoom);
    g_pan_x = pan_x;
    g_pan_y = pan_y;
    clamp_pan();
    update_scale_bar();
    request_redraw();
}

bool on_resize(int /*eventType*/, const EmscriptenUiEvent* /*e*/, void* /*userData*/) {
    resize_canvas();
    return true;
}

// Triangulates polys (already fully positioned in whatever coordinate frame
// the caller wants -- world space for static layers, unit space for an
// instance group's shape) into the same JS-facing
// {outlineVertices,outlineRanges,fillVertices,fillRanges} layout
// parseGdsToLayers has always produced, reusable for both. Reports the
// bounding box of every point it consumed via out_min/max (min > max if
// polys was empty) so the caller can fold it into whatever bbox accumulator
// applies (design bbox for static layers, unit-shape bbox for a group -- see
// parseGdsToLayers). Frees every Polygon* in polys before returning.
val build_layer_entry(uint64_t tag, std::vector<Polygon*>& polys, uint64_t& out_polygon_count,
                      double& out_min_x, double& out_max_x, double& out_min_y, double& out_max_y) {
    out_polygon_count = polys.size();
    out_min_x = HUGE_VAL;
    out_max_x = -HUGE_VAL;
    out_min_y = HUGE_VAL;
    out_max_y = -HUGE_VAL;

    uint64_t point_total = 0;
    for (Polygon* poly : polys) point_total += poly->point_array.count;

    std::vector<float> outline_vertices;
    outline_vertices.reserve(point_total * 2);
    std::vector<float> fill_vertices;
    val outline_ranges = val::array();
    val fill_ranges = val::array();
    std::vector<uint32_t> tri_indices;

    auto append_fill = [&](const Array<Vec2>& pts, const std::vector<uint32_t>& indices) {
        if (indices.empty()) return;
        uint32_t fill_first = (uint32_t)(fill_vertices.size() / 2);
        for (uint32_t idx : indices) {
            const Vec2& pt = pts[idx];
            fill_vertices.push_back((float)pt.x);
            fill_vertices.push_back((float)pt.y);
        }
        val fill_range = val::array();
        fill_range.set(0, fill_first);
        fill_range.set(1, (uint32_t)indices.size());
        fill_ranges.call<void>("push", fill_range);
    };

    for (Polygon* poly : polys) {
        uint32_t first = (uint32_t)(outline_vertices.size() / 2);
        for (uint64_t i = 0; i < poly->point_array.count; i++) {
            const Vec2& pt = poly->point_array[i];
            outline_vertices.push_back((float)pt.x);
            outline_vertices.push_back((float)pt.y);
            out_min_x = std::min(out_min_x, pt.x);
            out_max_x = std::max(out_max_x, pt.x);
            out_min_y = std::min(out_min_y, pt.y);
            out_max_y = std::max(out_max_y, pt.y);
        }
        val outline_range = val::array();
        outline_range.set(0, first);
        outline_range.set(1, (uint32_t)poly->point_array.count);
        outline_ranges.call<void>("push", outline_range);

        tri_indices.clear();
        triangulate(poly->point_array, tri_indices);
        // A simple polygon with n vertices triangulates into exactly n-2
        // triangles; fewer means triangulate() declined (over the point cap)
        // or bailed partway (degenerate input, e.g. the self-touching comb
        // slits some tools emit to represent holes). Fall back to gdstk's
        // fracture(), whose horizontal/vertical cuts both bound the piece
        // size and split away most degeneracies, and triangulate the pieces.
        // Fill only -- the outline above still traces the original polygon,
        // and the seams the cuts introduce are invisible: normal mode never
        // strokes fill internals, and merge mode's coverage mask unions the
        // pieces back together.
        uint64_t n = poly->point_array.count;
        bool complete = n >= 3 && tri_indices.size() == (size_t)(n - 2) * 3;
        if (complete || n < 3) {
            append_fill(poly->point_array, tri_indices);
        } else {
            Array<Polygon*> pieces = {};
            // precision = 1e-3: coordinates are in microns (see read_layout's
            // unit argument), so cuts snap to a 1 nm grid.
            poly->fracture(kMaxTriangulatePoints, 1e-3, pieces);
            if (pieces.count == 0) {
                // fracture had nothing to offer -- keep whatever partial
                // triangulation the ear clipper managed.
                append_fill(poly->point_array, tri_indices);
            }
            for (uint64_t p = 0; p < pieces.count; p++) {
                Polygon* piece = pieces[p];
                tri_indices.clear();
                triangulate(piece->point_array, tri_indices);
                append_fill(piece->point_array, tri_indices);
                piece->clear();
                free_allocation(piece);
            }
            pieces.clear();
        }
    }

    val layer_entry = val::object();
    layer_entry.set("layer", get_layer(tag));
    layer_entry.set("datatype", get_type(tag));
    layer_entry.set("outlineVertices", to_float32_array(outline_vertices));
    layer_entry.set("outlineRanges", outline_ranges);
    layer_entry.set("fillVertices", to_float32_array(fill_vertices));
    layer_entry.set("fillRanges", fill_ranges);

    for (Polygon* poly : polys) {
        poly->clear();
        free_allocation(poly);
    }

    return layer_entry;
}

// Adds one layer's labels to the entry build_layer_entry produced, and grows
// the design bbox by their origins (a label is part of the design, and a
// text-only layout has no polygons to frame the view on otherwise).
//
// The text crosses to JS as one flat byte blob plus a length per label rather
// than an array of JS strings: same bulk-typed-array convention as the vertex
// data, and the main thread rebuilds the std::strings from the bytes without
// marshalling a JS string per label (see uploadLayers). GDSII/OASIS text is
// bytes with no declared encoding, so nothing here interprets them.
void attach_labels(val& layer_entry, const std::vector<CollectedLabel>& labels, double& min_x, double& max_x,
                   double& min_y, double& max_y) {
    std::vector<uint8_t> chars;
    std::vector<uint32_t> lengths;
    std::vector<float> origins;
    std::vector<uint8_t> anchors;
    lengths.reserve(labels.size());
    origins.reserve(labels.size() * 2);
    anchors.reserve(labels.size());

    for (const CollectedLabel& label : labels) {
        chars.insert(chars.end(), label.text.begin(), label.text.end());
        lengths.push_back((uint32_t)label.text.size());
        origins.push_back((float)label.x);
        origins.push_back((float)label.y);
        anchors.push_back(label.anchor);
        min_x = std::min(min_x, label.x);
        max_x = std::max(max_x, label.x);
        min_y = std::min(min_y, label.y);
        max_y = std::max(max_y, label.y);
    }

    layer_entry.set("textChars", to_uint8_array(chars));
    layer_entry.set("textLengths", to_uint32_array(lengths));
    layer_entry.set("textOrigins", to_float32_array(origins));
    layer_entry.set("textAnchors", to_uint8_array(anchors));
}

// One layer's worth of build_layer_entry work, queued so that all of it --
// static layers, label-only layers, and every instance group's unit shape --
// can be run as a single pass with one honest progress denominator (see
// parseGdsToLayers). polys stays owned by the map the job was queued from;
// build_layer_entry frees the polygons out of it.
struct LayerJob {
    uint64_t tag = 0;
    std::vector<Polygon*>* polys = nullptr;
    val entry = val::undefined();
    uint64_t polygon_count = 0;
    double min_x = HUGE_VAL, max_x = -HUGE_VAL, min_y = HUGE_VAL, max_y = -HUGE_VAL;
};

// Shuffles the *order jobs are run in* (not the order their results are
// emitted in) so the progress bar advances at a roughly even rate. Per-layer
// triangulation cost spans orders of magnitude -- a routing layer with a
// million small polygons against a handful of big filled shapes -- and both
// the queue order and the hash order behind it keep related, similarly
// expensive layers adjacent, so a straight walk sprints through the cheap
// run and then stalls on the expensive one. Interleaving them makes elapsed
// time track the fraction reported. The seed is fixed, so a given layout
// always triangulates in the same order.
void shuffle_run_order(std::vector<size_t>& order) {
    uint64_t state = 0x9E3779B97F4A7C15ull;
    auto next = [&state]() {  // splitmix64
        uint64_t z = (state += 0x9E3779B97F4A7C15ull);
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
        return z ^ (z >> 31);
    };
    for (size_t i = order.size(); i > 1; i--) {
        std::swap(order[i - 1], order[(size_t)(next() % i)]);
    }
}

// Result of uploading one {outlineVertices,outlineRanges,fillVertices,
// fillRanges} JS entry (as produced by build_layer_entry) to fresh GL
// buffers -- shared by both uploadLayers' static per-layer path and its
// per-(instance group, layer) path, which otherwise did the exact same VBO/
// EBO construction.
struct UploadedGeometry {
    GLuint outline_vbo = 0;
    GLuint outline_ebo = 0;
    GLsizei outline_index_count = 0;
    GLsizei outline_vertex_count = 0;
    GLuint fill_vbo = 0;
    GLsizei fill_vertex_count = 0;
    uint32_t polygon_count = 0;
    float min_x = HUGE_VAL, max_x = -HUGE_VAL, min_y = HUGE_VAL, max_y = -HUGE_VAL;
};

// Inverse of attach_labels: unpacks a layer entry's flat text arrays into the
// layer's TextLabel list and grows its cull box by the label origins, so a
// layer whose only content is text still passes draw_frame's bbox test.
void upload_labels(LayerBuffer& layer, val entry) {
    val lengths_value = entry["textLengths"];
    if (lengths_value.isUndefined() || lengths_value.isNull()) return;

    std::vector<uint32_t> lengths = convertJSArrayToNumberVector<uint32_t>(lengths_value);
    if (lengths.empty()) return;
    std::vector<uint8_t> chars = convertJSArrayToNumberVector<uint8_t>(entry["textChars"]);
    std::vector<float> origins = convertJSArrayToNumberVector<float>(entry["textOrigins"]);
    std::vector<uint8_t> anchors = convertJSArrayToNumberVector<uint8_t>(entry["textAnchors"]);

    layer.labels.reserve(layer.labels.size() + lengths.size());
    size_t cursor = 0;
    for (size_t i = 0; i < lengths.size(); i++) {
        // Defensive: a truncated payload stops the loop rather than reading
        // past the end of any of the four parallel arrays.
        if (cursor + lengths[i] > chars.size()) break;
        if (i * 2 + 1 >= origins.size() || i >= anchors.size()) break;
        TextLabel label;
        label.x = origins[i * 2];
        label.y = origins[i * 2 + 1];
        label.anchor = anchors[i];
        label.text.assign(reinterpret_cast<const char*>(chars.data()) + cursor, lengths[i]);
        cursor += lengths[i];
        layer.min_x = std::min(layer.min_x, label.x);
        layer.max_x = std::max(layer.max_x, label.x);
        layer.min_y = std::min(layer.min_y, label.y);
        layer.max_y = std::max(layer.max_y, label.y);
        layer.labels.push_back(std::move(label));
    }
}

UploadedGeometry upload_geometry(val entry) {
    UploadedGeometry g;

    // convertJSArrayToNumberVector does one bulk typed_memory_view copy;
    // vecFromJSArray would marshal one element at a time, which is too slow
    // for vertex buffers that can run into the millions of floats.
    std::vector<float> outline_vertices = convertJSArrayToNumberVector<float>(entry["outlineVertices"]);
    std::vector<float> fill_vertices = convertJSArrayToNumberVector<float>(entry["fillVertices"]);

    val outline_ranges = entry["outlineRanges"];
    unsigned outline_range_count = outline_ranges["length"].as<unsigned>();
    // Indices for outline_ebo: each polygon's boundary expanded into explicit
    // GL_LINES edge pairs -- (v0,v1), (v1,v2) ... (vN-1,v0), with the closing
    // edge written out rather than implied. Costs ~2 indices per vertex
    // instead of ~1, and in exchange the whole layer/batch still draws in one
    // glDraw(Elements|ElementsInstanced) call (see draw_frame), with no
    // restart markers and no line-loop topology.
    //
    // This used to be restart-joined GL_LINE_LOOPs, which is a worse deal than
    // the index count suggests: no modern GPU API has a line-loop primitive
    // (not D3D11/12, not Vulkan, not Metal -- it is an OpenGL legacy topology
    // that survived into GLES 3.0 and hence WebGL2), so ANGLE has to
    // synthesize the closing edge on every backend, and the restart markers
    // additionally force it to scan the index stream for topology breaks. A
    // plain line list passes through unconverted everywhere.
    std::vector<uint32_t> outline_indices;
    outline_indices.reserve(outline_vertices.size());
    for (unsigned r = 0; r < outline_range_count; r++) {
        val range = outline_ranges[r];
        uint32_t first = range[0].as<uint32_t>();
        uint32_t count = range[1].as<uint32_t>();
        PolygonRange pr = make_range(outline_vertices, (GLint)first, (GLsizei)count);
        g.min_x = std::min(g.min_x, pr.min_x);
        g.max_x = std::max(g.max_x, pr.max_x);
        g.min_y = std::min(g.min_y, pr.min_y);
        g.max_y = std::max(g.max_y, pr.max_y);
        // A degenerate single-point range has no edge to draw; the loop below
        // would emit the zero-length pair (v0,v0) for it.
        if (count < 2) continue;
        for (uint32_t k = 0; k < count; k++) {
            outline_indices.push_back(first + k);
            outline_indices.push_back(first + (k + 1 == count ? 0 : k + 1));
        }
    }
    g.polygon_count = outline_range_count;
    g.outline_vertex_count = (GLsizei)(outline_vertices.size() / 2);
    g.fill_vertex_count = (GLsizei)(fill_vertices.size() / 2);

    glGenBuffers(1, &g.outline_vbo);
    glBindBuffer(GL_ARRAY_BUFFER, g.outline_vbo);
    buffer_data_tracked(GL_ARRAY_BUFFER, g.outline_vbo, (GLsizeiptr)(outline_vertices.size() * sizeof(float)),
                        outline_vertices.data(), GL_STATIC_DRAW);

    if (!outline_indices.empty()) {
        glGenBuffers(1, &g.outline_ebo);
        glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, g.outline_ebo);
        buffer_data_tracked(GL_ELEMENT_ARRAY_BUFFER, g.outline_ebo,
                            (GLsizeiptr)(outline_indices.size() * sizeof(uint32_t)), outline_indices.data(),
                            GL_STATIC_DRAW);
        g.outline_index_count = (GLsizei)outline_indices.size();
    }

    if (!fill_vertices.empty()) {
        glGenBuffers(1, &g.fill_vbo);
        glBindBuffer(GL_ARRAY_BUFFER, g.fill_vbo);
        buffer_data_tracked(GL_ARRAY_BUFFER, g.fill_vbo, (GLsizeiptr)(fill_vertices.size() * sizeof(float)),
                            fill_vertices.data(), GL_STATIC_DRAW);
    }

    return g;
}

}  // namespace

// Parses, flattens, and triangulates a layout file (GDSII or OASIS -- the
// format is sniffed from the file's header, see gds_common::detect_format)
// into plain per-layer vertex data -- no GL/DOM touched, so this is safe to
// run inside a Worker (see wasm-worker.js) as well as on the main thread.
// Reports progress via report_progress() as it goes; the caller (JS) is
// expected to relay 'gdsProgress' postMessages to whatever's driving a
// progress bar.
val parseGdsToLayers(const std::string& path) {
    val result = val::object();

    report_progress("parsing", 0, 1);
    ErrorCode error_code = ErrorCode::NoError;
    gds_common::FileFormat format = gds_common::FileFormat::Gds;
    Library lib = gds_common::read_layout(path.c_str(), 1e-6, 1e-2, &format, &error_code);
    report_progress("parsing", 1, 1);

    if (gds_common::is_fatal(error_code)) {
        result.set("ok", false);
        result.set("error", std::string(gds_common::error_string(error_code, format)));
        lib.free_all();
        return result;
    }

    Array<Cell*> top_cells = {};
    Array<RawCell*> top_rawcells = {};
    lib.top_level(top_cells, top_rawcells);

    // The cells we actually render at top level (each an instance-count root):
    // every non-metadata top cell, or -- if the hierarchy has no clean root
    // (e.g. a reference cycle) -- the last cell defined, mirroring common GDS
    // tooling. base_counts seeds compute_instance_count with 1 per root.
    std::vector<Cell*> roots;
    for (uint64_t i = 0; i < top_cells.count; i++) {
        if (!gds_common::is_metadata_cell(top_cells[i])) roots.push_back(top_cells[i]);
    }
    if (roots.empty() && lib.cell_array.count > 0) {
        roots.push_back(lib.cell_array[lib.cell_array.count - 1]);
    }
    top_cells.clear();
    top_rawcells.clear();

    std::unordered_map<Cell*, double> base_counts;
    for (Cell* root : roots) base_counts[root] += 1.0;

    // The cell tree for the viewer's hierarchy panel. Built here, before the
    // flatten allocates the design's worth of polygons, because it needs the
    // Library's own reference arrays and only holds a box per cell.
    val hierarchy = build_hierarchy(lib, roots);

    // Decide which cells are reused enough to GPU-instance, then split the
    // design into static geometry + one instance group per instanced cell.
    std::unordered_map<Cell*, bool> instanced = choose_instanced_cells(lib, base_counts);

    std::unordered_map<uint64_t, std::vector<Polygon*>> by_layer_static;
    std::unordered_map<Cell*, InstanceGroupPolys> groups;
    LabelSink labels;
    uint64_t root_index = 0;
    for (Cell* root : roots) {
        collect_instanced(root, Affine2D{}, instanced, by_layer_static, groups, labels);
        root_index++;
        report_progress("flattening", root_index, roots.size());
    }

    // Build the unit shape (once) for every cell that actually got instances.
    for (auto& kv : groups) {
        build_cell_template(kv.first, kv.second.by_layer_unit);
    }

    // Labels inside instanced cells. Unlike the geometry, these aren't drawn
    // through GPU instancing (glyphs are built per label at a fixed pixel
    // size, so there's no shared unit shape to instance), so each placement
    // gets its own world-space copy -- which is what kMaxLabels bounds.
    for (auto& kv : groups) {
        Array<Label*> cell_labels = {};
        kv.first->get_labels(true, -1, false, 0, cell_labels);
        for (uint64_t i = 0; i < cell_labels.count; i++) {
            Label* label = cell_labels[i];
            for (const Affine2D& placement : kv.second.instances) {
                Vec2 p = placement.apply_point(label->origin);
                labels.add(label->tag, p.x, p.y, (uint8_t)label->anchor, label->text);
            }
            label->clear();
            free_allocation(label);
        }
        cell_labels.clear();
    }
    if (labels.capped) {
        EM_ASM({ console.log('[GDS] label limit reached (' + $0 + ') -- some labels will not be drawn'); },
               (double)kMaxLabels);
    }

    double min_x = HUGE_VAL, max_x = -HUGE_VAL;
    double min_y = HUGE_VAL, max_y = -HUGE_VAL;
    uint64_t total_polygons = 0;

    val layers = val::array();

    // Queue every layer that needs triangulating -- static ones first, then
    // label-only ones, then each instance group's unit shape -- and build
    // them all in one shuffled pass below. Queue order is the order results
    // are emitted in (and so the order layers stack in), which is why the
    // shuffle permutes a separate index list rather than the jobs themselves.
    std::vector<LayerJob> jobs;
    std::vector<Polygon*> no_polygons;  // label-only layers: text, no geometry
    auto queue_job = [&jobs](uint64_t tag, std::vector<Polygon*>& polys) {
        LayerJob job;
        job.tag = tag;
        job.polys = &polys;
        jobs.push_back(job);
    };

    for (auto& entry : by_layer_static) queue_job(entry.first, entry.second);
    size_t static_end = jobs.size();

    // Tags that only ever appear as labels still become layers of their own
    // (real decks do put pin text on a texttype with no geometry on it).
    for (auto& kv : labels.by_tag) {
        if (by_layer_static.count(kv.first) == 0) queue_job(kv.first, no_polygons);
    }
    size_t label_only_end = jobs.size();

    // Each group's jobs occupy jobs[cursor, end) -- the end index recorded
    // here, the cursor walked forward as the group loop below consumes them.
    std::vector<std::pair<InstanceGroupPolys*, size_t>> group_job_ends;
    for (auto& kv : groups) {
        for (auto& entry : kv.second.by_layer_unit) queue_job(entry.first, entry.second);
        group_job_ends.emplace_back(&kv.second, jobs.size());
    }

    std::vector<size_t> run_order(jobs.size());
    for (size_t i = 0; i < run_order.size(); i++) run_order[i] = i;
    shuffle_run_order(run_order);

    uint64_t layer_index = 0;
    for (size_t i : run_order) {
        LayerJob& job = jobs[i];
        job.entry = build_layer_entry(job.tag, *job.polys, job.polygon_count, job.min_x, job.max_x, job.min_y,
                                      job.max_y);
        layer_index++;
        report_progress("triangulating", layer_index, jobs.size());
    }

    const std::vector<CollectedLabel> kNoLabels;
    for (size_t i = 0; i < static_end; i++) {
        LayerJob& job = jobs[i];
        if (job.polygon_count > 0 && job.min_x <= job.max_x) {
            min_x = std::min(min_x, job.min_x);
            max_x = std::max(max_x, job.max_x);
            min_y = std::min(min_y, job.min_y);
            max_y = std::max(max_y, job.max_y);
        }
        auto label_it = labels.by_tag.find(job.tag);
        attach_labels(job.entry, label_it != labels.by_tag.end() ? label_it->second : kNoLabels, min_x, max_x,
                      min_y, max_y);
        total_polygons += job.polygon_count;
        layers.call<void>("push", job.entry);
    }

    for (size_t i = static_end; i < label_only_end; i++) {
        LayerJob& job = jobs[i];
        attach_labels(job.entry, labels.by_tag.find(job.tag)->second, min_x, max_x, min_y, max_y);
        layers.call<void>("push", job.entry);
    }

    // Each instance group becomes one JS entry: a flat per-instance affine
    // array (6 floats each -- col0.xy, col1.xy, translate.xy) plus the group's
    // unit shape split by layer the same way static layers are. The group's
    // world footprint is the unit-shape bbox's four corners mapped through
    // every instance affine (rotation/mirror can vary per instance, so a
    // simple min/max of translations isn't enough) -- used both to grow the
    // design bbox here and, on the main thread, each touched layer's cull box.
    val instance_groups_js = val::array();
    size_t group_job_cursor = label_only_end;
    for (auto& gr : group_job_ends) {
        InstanceGroupPolys& group = *gr.first;
        double group_min_x = HUGE_VAL, group_max_x = -HUGE_VAL;
        double group_min_y = HUGE_VAL, group_max_y = -HUGE_VAL;
        val group_layers = val::array();
        uint64_t unit_polygon_count_sum = 0;

        for (size_t i = group_job_cursor; i < gr.second; i++) {
            LayerJob& job = jobs[i];
            if (job.polygon_count > 0 && job.min_x <= job.max_x) {
                group_min_x = std::min(group_min_x, job.min_x);
                group_max_x = std::max(group_max_x, job.max_x);
                group_min_y = std::min(group_min_y, job.min_y);
                group_max_y = std::max(group_max_y, job.max_y);
            }
            unit_polygon_count_sum += job.polygon_count;
            group_layers.call<void>("push", job.entry);
        }
        group_job_cursor = gr.second;

        uint64_t instance_count = group.instances.size();
        total_polygons += unit_polygon_count_sum * instance_count;

        std::vector<float> instances_flat;
        instances_flat.reserve(group.instances.size() * kInstanceStrideFloats);
        double g_min_x = HUGE_VAL, g_max_x = -HUGE_VAL, g_min_y = HUGE_VAL, g_max_y = -HUGE_VAL;
        bool have_unit_bbox = unit_polygon_count_sum > 0 && group_min_x <= group_max_x;
        Vec2 unit_corners[4] = {{group_min_x, group_min_y},
                                {group_max_x, group_min_y},
                                {group_min_x, group_max_y},
                                {group_max_x, group_max_y}};
        for (const Affine2D& m : group.instances) {
            instances_flat.push_back((float)m.a);
            instances_flat.push_back((float)m.c);
            instances_flat.push_back((float)m.b);
            instances_flat.push_back((float)m.d);
            instances_flat.push_back((float)m.tx);
            instances_flat.push_back((float)m.ty);
            if (have_unit_bbox) {
                for (const Vec2& corner : unit_corners) {
                    Vec2 w = m.apply_point(corner);
                    g_min_x = std::min(g_min_x, w.x);
                    g_max_x = std::max(g_max_x, w.x);
                    g_min_y = std::min(g_min_y, w.y);
                    g_max_y = std::max(g_max_y, w.y);
                }
            }
        }

        if (have_unit_bbox && instance_count > 0) {
            min_x = std::min(min_x, g_min_x);
            max_x = std::max(max_x, g_max_x);
            min_y = std::min(min_y, g_min_y);
            max_y = std::max(max_y, g_max_y);
        }

        val group_bbox = val::object();
        group_bbox.set("minX", g_min_x);
        group_bbox.set("maxX", g_max_x);
        group_bbox.set("minY", g_min_y);
        group_bbox.set("maxY", g_max_y);

        val group_entry = val::object();
        group_entry.set("instances", to_float32_array(instances_flat));
        group_entry.set("layers", group_layers);
        group_entry.set("bbox", group_bbox);
        instance_groups_js.call<void>("push", group_entry);
    }

    lib.free_all();

    // min > max is the "nothing at all in this layout" sentinel: neither a
    // polygon nor a label ever widened it (label origins count -- a layout
    // that is only text still has to be framed on something).
    bool have_bbox = min_x <= max_x;
    val bbox = val::object();
    bbox.set("minX", have_bbox ? min_x : 0.0);
    bbox.set("maxX", have_bbox ? max_x : 0.0);
    bbox.set("minY", have_bbox ? min_y : 0.0);
    bbox.set("maxY", have_bbox ? max_y : 0.0);

    result.set("ok", true);
    result.set("error", std::string(gds_common::error_string(error_code, format)));
    result.set("format", std::string(gds_common::format_name(format)));
    result.set("layers", layers);
    result.set("instanceGroups", instance_groups_js);
    result.set("hierarchy", hierarchy);
    result.set("bbox", bbox);
    result.set("totalPolygons", total_polygons);
    result.set("totalLabels", labels.count);
    result.set("labelsCapped", labels.capped);
    return result;
}

// GL-upload half of the old loadAndRenderGds: takes the plain per-layer
// vertex data produced by parseGdsToLayers() (either called directly, or
// reconstructed from a Worker's 'gdsResult' postMessage) and turns it into
// VBOs + camera framing. Must run on the main thread (owns the GL context).
void uploadLayers(val layers_data, val instance_groups_data, val bbox_data) {
    if (!g_gl_ready) return;
    clear_layers();
    // Rulers are anchored to the old file's geometry -- drop them rather than
    // leaving stale ones floating over the new design.
    g_measurements.clear();
    g_measure_pending = false;
    g_snap_active = false;

    unsigned layer_count = layers_data["length"].as<unsigned>();
    unsigned group_count = instance_groups_data["length"].as<unsigned>();

    // Reserve enough capacity that g_layers never reallocates while this
    // function holds a raw pointer into it (see the group loop below) -- a
    // layer that only appears inside a repeated reference, never directly at
    // the top level, creates a brand new entry while processing groups.
    uint64_t max_new_layers = layer_count;
    for (unsigned gi = 0; gi < group_count; gi++) {
        max_new_layers += instance_groups_data[gi]["layers"]["length"].as<unsigned>();
    }
    g_layers.reserve(g_layers.size() + max_new_layers);

    std::unordered_map<uint64_t, size_t> layer_index_by_tag;
    uint64_t total_polygons = 0;
    uint64_t total_labels = 0;

    for (unsigned i = 0; i < layer_count; i++) {
        val entry = layers_data[i];
        LayerBuffer layer_buffer;
        layer_buffer.layer = entry["layer"].as<uint32_t>();
        layer_buffer.datatype = entry["datatype"].as<uint32_t>();

        UploadedGeometry g = upload_geometry(entry);
        layer_buffer.outline_vbo = g.outline_vbo;
        layer_buffer.outline_ebo = g.outline_ebo;
        layer_buffer.outline_index_count = g.outline_index_count;
        layer_buffer.outline_vertex_count = g.outline_vertex_count;
        layer_buffer.fill_vbo = g.fill_vbo;
        layer_buffer.fill_vertex_count = g.fill_vertex_count;
        layer_buffer.polygon_count = g.polygon_count;
        layer_buffer.min_x = g.min_x;
        layer_buffer.max_x = g.max_x;
        layer_buffer.min_y = g.min_y;
        layer_buffer.max_y = g.max_y;
        total_polygons += g.polygon_count;
        // After the geometry bbox, since it widens the same fields.
        upload_labels(layer_buffer, entry);
        total_labels += layer_buffer.labels.size();

        apply_layer_colors(layer_buffer);
        layer_index_by_tag[layer_buffer.tag()] = g_layers.size();
        g_layers.push_back(std::move(layer_buffer));
    }

    // Instanced cells: one shared per-instance affine buffer per group (see
    // InstancedBatch), plus one InstancedBatch per layer the group's unit
    // shape touches -- possibly on a layer with no static geometry of its own
    // at all, hence find-or-create rather than an index lookup. The whole
    // group's precomputed world bbox (which already accounts for per-instance
    // rotation/mirror -- see parseGdsToLayers) is folded into each touched
    // layer's cull box.
    for (unsigned gi = 0; gi < group_count; gi++) {
        val group = instance_groups_data[gi];
        std::vector<float> instances = convertJSArrayToNumberVector<float>(group["instances"]);
        GLsizei instance_count = (GLsizei)(instances.size() / kInstanceStrideFloats);
        if (instance_count == 0) continue;

        val group_bbox = group["bbox"];
        float gb_min_x = (float)group_bbox["minX"].as<double>();
        float gb_max_x = (float)group_bbox["maxX"].as<double>();
        float gb_min_y = (float)group_bbox["minY"].as<double>();
        float gb_max_y = (float)group_bbox["maxY"].as<double>();
        bool have_group_bbox = gb_min_x <= gb_max_x;

        GLuint instance_vbo = 0;
        glGenBuffers(1, &instance_vbo);
        glBindBuffer(GL_ARRAY_BUFFER, instance_vbo);
        buffer_data_tracked(GL_ARRAY_BUFFER, instance_vbo, (GLsizeiptr)(instances.size() * sizeof(float)),
                            instances.data(), GL_STATIC_DRAW);

        val group_layers = group["layers"];
        unsigned group_layer_count = group_layers["length"].as<unsigned>();
        for (unsigned li = 0; li < group_layer_count; li++) {
            val entry = group_layers[li];
            uint32_t layer_number = entry["layer"].as<uint32_t>();
            uint32_t datatype = entry["datatype"].as<uint32_t>();
            uint64_t tag = make_tag(layer_number, datatype);
            UploadedGeometry g = upload_geometry(entry);

            LayerBuffer* layer_buffer;
            auto it = layer_index_by_tag.find(tag);
            if (it != layer_index_by_tag.end()) {
                layer_buffer = &g_layers[it->second];
            } else {
                LayerBuffer new_layer;
                new_layer.layer = layer_number;
                new_layer.datatype = datatype;
                apply_layer_colors(new_layer);
                layer_index_by_tag[tag] = g_layers.size();
                g_layers.push_back(std::move(new_layer));
                layer_buffer = &g_layers.back();
            }

            InstancedBatch batch;
            batch.fill_vbo = g.fill_vbo;
            batch.fill_vertex_count = g.fill_vertex_count;
            batch.outline_vbo = g.outline_vbo;
            batch.outline_ebo = g.outline_ebo;
            batch.outline_index_count = g.outline_index_count;
            batch.outline_vertex_count = g.outline_vertex_count;
            batch.instance_vbo = instance_vbo;
            batch.instance_count = instance_count;
            layer_buffer->instanced_batches.push_back(batch);

            uint64_t logical_count = (uint64_t)g.polygon_count * (uint64_t)instance_count;
            layer_buffer->polygon_count += (uint32_t)logical_count;
            total_polygons += logical_count;

            if (g.polygon_count > 0 && have_group_bbox) {
                layer_buffer->min_x = std::min(layer_buffer->min_x, gb_min_x);
                layer_buffer->max_x = std::max(layer_buffer->max_x, gb_max_x);
                layer_buffer->min_y = std::min(layer_buffer->min_y, gb_min_y);
                layer_buffer->max_y = std::max(layer_buffer->max_y, gb_max_y);
            }
        }
    }

    double min_x = bbox_data["minX"].as<double>();
    double max_x = bbox_data["maxX"].as<double>();
    double min_y = bbox_data["minY"].as<double>();
    double max_y = bbox_data["maxY"].as<double>();

    // Labels count as content: a layout with nothing but text still has to be
    // framed on its bbox rather than falling back to the origin-at-zoom-1 case.
    if ((total_polygons > 0 || total_labels > 0) && min_x <= max_x) {
        double total_width = max_x - min_x;
        double total_height = max_y - min_y;
        g_pan_x = (float)(min_x + total_width / 2.0);
        g_pan_y = (float)(min_y + total_height / 2.0);
        double zoom_x = g_canvas_width / (total_width > 0 ? total_width : 1.0);
        double zoom_y = g_canvas_height / (total_height > 0 ? total_height : 1.0);
        g_zoom = (float)(std::min(zoom_x, zoom_y) * 0.85);
        g_bbox_min_x = (float)min_x;
        g_bbox_max_x = (float)max_x;
        g_bbox_min_y = (float)min_y;
        g_bbox_max_y = (float)max_y;
    } else {
        g_zoom = 1.0f;
        g_pan_x = 0.0f;
        g_pan_y = 0.0f;
        g_bbox_min_x = HUGE_VALF;
        g_bbox_max_x = -HUGE_VALF;
        g_bbox_min_y = HUGE_VALF;
        g_bbox_max_y = -HUGE_VALF;
    }
    g_fit_zoom = g_zoom;
    g_fit_pan_x = g_pan_x;
    g_fit_pan_y = g_pan_y;
    g_total_polygons = total_polygons;
    g_total_labels = total_labels;
    g_text_dirty = true;

    // #renderStats is a placeholder draw_frame overwrites every redraw (see
    // update_render_stats) with the live visible-polygon-count / rendering-
    // mode readout -- kept as a separate span so draw_frame's per-frame
    // update doesn't have to re-set the static title/count text above it.
    set_inner_html("ui", "<b>GDSII Core Engine Active</b><br>Polygons: " + std::to_string(total_polygons) +
                              "<br>Labels: " + std::to_string(total_labels) +
                              "<br><span id=\"renderStats\"></span>");
    update_scale_bar();
    request_redraw();
}

void showLoadError(const std::string& message) {
    // Write the visible panel FIRST and unconditionally: #ui below sits inside
    // the debug panel, which is closed unless the debug command opened it, and
    // a failure early enough to leave GL uninitialized is exactly when the user
    // most needs to see why. set_inner_text, not html -- the message can
    // carry a filename or a gdstk string we don't control.
    set_inner_text("loadError", std::string("Could not open this layout\n\n") + message);

    if (!g_gl_ready) return;
    clear_layers();
    // With no layers draw_frame early-returns and can't take the ruler labels
    // down, so do it here directly.
    g_measurements.clear();
    g_measure_pending = false;
    g_snap_active = false;
    update_measure_labels();
    set_inner_html("ui", std::string("<b>Error</b><br>") + message);
    request_redraw();
}

// Synchronous single-call path kept for callers that don't need progress
// reporting -- parseGdsToLayers()/uploadLayers() are what viewer.js actually
// drives via the Worker now.
void loadAndRenderGds(const std::string& path) {
    if (!g_gl_ready) {
        // No WebGL2-capable canvas (e.g. running under plain Node) -- use
        // parseGds() instead for headless parse-path testing.
        return;
    }
    val r = parseGdsToLayers(path);
    if (!r["ok"].as<bool>()) {
        showLoadError(r["error"].as<std::string>());
        return;
    }
    uploadLayers(r["layers"], r["instanceGroups"], r["bbox"]);
}

// Parse one leaf .lyp block -- the region covering a single layer, containing
// exactly one <source> -- and insert it into g_lyp_info under `category`. A
// no-op when the block has no numeric <source> (e.g. a subgroup header, or
// KLayout's catch-all "*/*") or is bound to a layout other than the first.
// An entry without colors is still kept (its name and visibility apply; the
// colors fall back to the hash defaults in apply_layer_colors). group_visible
// carries the enclosing group node's <visible> flag: KLayout hides every
// child of an invisible group regardless of the child's own flag.
void parse_lyp_leaf(const std::string& block, const std::string& category, bool group_visible) {
    // <source> is "layer/datatype@layout-index" (e.g. "250/9@1"). Split off the
    // layer at '/', then the datatype up to '@' (or end). A missing datatype
    // defaults to 0.
    std::string source_text;
    if (!lyp_util::extract_tag_value(block, "source", source_text)) return;

    // A numeric layout index (@2, @3, ...) binds the entry to the Nth loaded
    // layout -- this viewer only ever has one, so entries for other layouts
    // are skipped rather than misapplied. "@1", "@*", and no index all apply.
    size_t at_pos = source_text.find('@');
    if (at_pos != std::string::npos) {
        std::string idx_text = lyp_util::trim(source_text.substr(at_pos + 1));
        char* idx_endptr = nullptr;
        long layout_index = strtol(idx_text.c_str(), &idx_endptr, 10);
        if (idx_endptr != idx_text.c_str() && layout_index != 1) return;
    }

    size_t slash_pos = source_text.find('/');
    std::string layer_text = lyp_util::trim(source_text.substr(0, slash_pos));
    if (layer_text.empty()) return;
    char* endptr = nullptr;
    long layer_number = strtol(layer_text.c_str(), &endptr, 10);
    if (endptr == layer_text.c_str()) return;

    long datatype_number = 0;
    if (slash_pos != std::string::npos) {
        std::string dt_text = source_text.substr(slash_pos + 1);
        if (at_pos != std::string::npos) dt_text = dt_text.substr(0, dt_text.find('@'));
        dt_text = lyp_util::trim(dt_text);
        char* dt_endptr = nullptr;
        long parsed = strtol(dt_text.c_str(), &dt_endptr, 10);
        // Only take a fully numeric datatype; a wildcard ("*") leaves it 0.
        if (dt_endptr != dt_text.c_str()) datatype_number = parsed;
    }

    LypEntry entry;
    entry.order = g_lyp_order_counter++;
    entry.group = category;

    std::string fill_text, frame_text;
    entry.has_fill = lyp_util::extract_tag_value(block, "fill-color", fill_text);
    entry.has_frame = lyp_util::extract_tag_value(block, "frame-color", frame_text);
    if (entry.has_fill) {
        entry.fill_color = lyp_util::hex_to_rgba(fill_text, 0.55f);
        if (entry.fill_color[3] == 0.0f) entry.has_fill = false;
    }
    if (entry.has_frame) {
        entry.frame_color = lyp_util::hex_to_rgba(frame_text, 0.9f);
        if (entry.frame_color[3] == 0.0f) entry.has_frame = false;
    }

    std::string brightness_text;
    if (entry.has_fill && lyp_util::extract_tag_value(block, "fill-brightness", brightness_text)) {
        lyp_util::apply_brightness(entry.fill_color,
                                   strtol(lyp_util::trim(brightness_text).c_str(), nullptr, 10));
    }
    if (entry.has_frame && lyp_util::extract_tag_value(block, "frame-brightness", brightness_text)) {
        lyp_util::apply_brightness(entry.frame_color,
                                   strtol(lyp_util::trim(brightness_text).c_str(), nullptr, 10));
    }

    std::string name_text;
    if (lyp_util::extract_tag_value(block, "name", name_text)) entry.name = lyp_util::trim(name_text);

    std::string visible_text;
    if (lyp_util::extract_tag_value(block, "visible", visible_text)) {
        std::string v = lyp_util::trim(visible_text);
        entry.visible = !(v == "false" || v == "0");
    }
    entry.visible = entry.visible && group_visible;

    g_lyp_info[make_tag((uint32_t)layer_number, (uint32_t)datatype_number)] = entry;
}

void loadLypText(const std::string& xml_text_in) {
    g_lyp_info.clear();
    g_lyp_order_counter = 0;

    std::string xml_text = lyp_util::strip_xml_comments(xml_text_in);

    // Multi-tab files: <layer-properties-tabs> wraps one <layer-properties>
    // element per tab. Parse only the first tab -- mirroring KLayout's initial
    // view -- instead of letting later tabs' entries overwrite earlier ones.
    // (find_open_tag can't match "<layer-properties-tabs" for the "<layer-
    // properties" prefix search below since '-' follows the name, so the first
    // hit is the first real tab.)
    if (xml_text.find("<layer-properties-tabs") != std::string::npos) {
        size_t tab_content = 0;
        if (lyp_util::find_open_tag(xml_text, "layer-properties", 0, tab_content) != std::string::npos) {
            size_t tab_close = xml_text.find("</layer-properties>", tab_content);
            if (tab_close != std::string::npos) {
                xml_text = xml_text.substr(tab_content, tab_close - tab_content);
            }
        }
    }

    // KLayout .lyp: the root <layer-properties> holds top-level <properties>
    // blocks. A <properties> block is either a single layer (has <source>
    // directly) or a group -- a <name> (the category, e.g. "Metals") plus one
    // or more <group-members>, each itself a layer or a further nested subgroup.
    // <properties> never nests; only <group-members> does. So: walk top-level
    // <properties> blocks; when a block contains <group-members>, its leading
    // <name> is the category; then flatten every <group-members> region into
    // leaf entries. Splitting on "<group-members>" flattens nested subgroups
    // too (a subgroup-header region carries no <source>, so parse_lyp_leaf skips
    // it), and every leaf inherits the outermost category -- exactly the flat
    // two-level (category -> layers) view the sidebar wants.
    size_t block_start = 0;
    size_t prop_pos = lyp_util::find_open_tag(xml_text, "properties", 0, block_start);
    while (prop_pos != std::string::npos) {
        size_t next_start = 0;
        size_t next_prop = lyp_util::find_open_tag(xml_text, "properties", block_start, next_start);
        size_t block_end = (next_prop == std::string::npos) ? xml_text.length() : next_prop;
        std::string top_block = xml_text.substr(block_start, block_end - block_start);
        prop_pos = next_prop;
        block_start = next_start;

        size_t leaf_start = 0;
        size_t first_members = lyp_util::find_open_tag(top_block, "group-members", 0, leaf_start);
        if (first_members == std::string::npos) {
            // Flat single-layer entry, no category.
            parse_lyp_leaf(top_block, "", true);
            continue;
        }

        // The group node's own <name>/<visible> live before the first
        // <group-members>. Its visibility cascades to every leaf below.
        std::string header = top_block.substr(0, first_members);
        std::string category;
        std::string name_text;
        if (lyp_util::extract_tag_value(header, "name", name_text)) category = lyp_util::trim(name_text);
        bool group_visible = true;
        std::string visible_text;
        if (lyp_util::extract_tag_value(header, "visible", visible_text)) {
            std::string v = lyp_util::trim(visible_text);
            group_visible = !(v == "false" || v == "0");
        }

        for (size_t m = first_members; m != std::string::npos;) {
            size_t next_leaf_start = 0;
            size_t next_m = lyp_util::find_open_tag(top_block, "group-members", leaf_start, next_leaf_start);
            size_t leaf_end = (next_m == std::string::npos) ? top_block.length() : next_m;
            parse_lyp_leaf(top_block.substr(leaf_start, leaf_end - leaf_start), category, group_visible);
            m = next_m;
            leaf_start = next_leaf_start;
        }
    }

    apply_lyp_to_layers();
    request_redraw();
}

// Small UI-facing summary (layer number, display name, CSS colors,
// visibility) for building the sidebar layer list in JS -- no per-polygon
// geometry crosses this boundary, just one short string/bool/number tuple
// per layer. Ordered with .lyp-defined layers first (in the order they
// appeared in the file, matching KLayout's own layer panel), then any
// .lyp-less layers present in the GDS, sorted numerically.
val getLayers() {
    std::vector<const LayerBuffer*> ordered;
    ordered.reserve(g_layers.size());
    for (const LayerBuffer& l : g_layers) ordered.push_back(&l);

    std::sort(ordered.begin(), ordered.end(), [](const LayerBuffer* a, const LayerBuffer* b) {
        auto ita = g_lyp_info.find(a->tag());
        auto itb = g_lyp_info.find(b->tag());
        bool has_a = ita != g_lyp_info.end();
        bool has_b = itb != g_lyp_info.end();
        if (has_a != has_b) return has_a;
        if (has_a && has_b && ita->second.order != itb->second.order)
            return ita->second.order < itb->second.order;
        if (a->layer != b->layer) return a->layer < b->layer;
        return a->datatype < b->datatype;
    });

    val result = val::array();
    int idx = 0;
    for (const LayerBuffer* l : ordered) {
        val obj = val::object();
        obj.set("layer", l->layer);
        obj.set("datatype", l->datatype);
        auto it = g_lyp_info.find(l->tag());
        obj.set("name", it != g_lyp_info.end() ? it->second.name : std::string());
        obj.set("group", it != g_lyp_info.end() ? it->second.group : std::string());
        obj.set("fillColor", rgba_to_css(l->fill_color));
        obj.set("frameColor", rgba_to_css(l->frame_color));
        obj.set("visible", l->visible);
        // What's actually on this layer in this file. A PDK's .lyp names a
        // hundred-odd layers and any one design uses a handful of them, so
        // "how much is here" is the difference between a list you scan and a
        // list you search. Both counts are logical, not GPU-side: polygons
        // include instanced copies (see LayerBuffer::polygon_count), and the
        // label count is what makes a text-only layer -- no polygons at all,
        // which real decks do have -- read as populated rather than empty.
        obj.set("polygonCount", l->polygon_count);
        obj.set("labelCount", (uint32_t)l->labels.size());
        result.set(idx++, obj);
    }
    return result;
}

// Toggle a single (layer, datatype). g_lyp_info is updated too so the
// visibility sticks across a GDS reload (apply_layer_colors reads it back).
void setLayerVisible(uint32_t layer_number, uint32_t datatype, bool visible) {
    uint64_t tag = make_tag(layer_number, datatype);
    for (LayerBuffer& l : g_layers) {
        if (l.tag() == tag) {
            l.visible = visible;
            break;
        }
    }
    auto it = g_lyp_info.find(tag);
    if (it != g_lyp_info.end()) it->second.visible = visible;
    g_text_dirty = true;  // the label buffer only holds visible layers' labels
    request_redraw();
}

// ---- Label search -----------------------------------------------------------
// A layout's own TEXT labels are its index: pad names, port names, block names,
// pin numbers. Which one you want is a string, so the viewer has to be able to
// look one up by it -- and the strings only exist here (LayerBuffer::labels,
// filled once by upload_labels and never handed back to JS, since a full chip's
// worth of them is far too much to hold a second time on the other side).
//
// ASCII case-insensitive substring match, in scan order rather than ranked:
// with a query broad enough to have a best match somewhere past the cap, the
// honest answer is the count plus "narrow it", not a ranking of the arbitrary
// prefix that fits. `limit` bounds the returned array only -- `total` counts
// every match -- so the panel can say "200 of 1,340" instead of implying 200
// was all there was.
//
// Hidden layers are searched too: a label you're hunting for is often on a
// layer you turned off, and "no such label" would be the wrong answer to give
// because of that. Each hit carries its layer's visibility so the row can say
// which ones aren't on screen.
char lower_ascii(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c; }

// `needle` must already be lowercased; `haystack` is folded as it's compared,
// so nothing is allocated per label -- this runs over every label in the design
// on every keystroke.
bool contains_ci(const std::string& haystack, const std::string& needle) {
    if (needle.empty()) return true;
    if (needle.size() > haystack.size()) return false;
    const size_t last = haystack.size() - needle.size();
    for (size_t i = 0; i <= last; i++) {
        size_t j = 0;
        while (j < needle.size() && lower_ascii(haystack[i + j]) == needle[j]) j++;
        if (j == needle.size()) return true;
    }
    return false;
}

val findLabels(const std::string& query_in, unsigned limit) {
    val out = val::object();
    val hits = val::array();
    uint64_t total = 0;
    int emitted = 0;

    std::string needle = query_in;
    for (char& c : needle) c = lower_ascii(c);

    // An empty query is "nothing asked for", not "everything matches" -- the
    // panel clears its result list on it rather than listing the design.
    if (!needle.empty()) {
        for (const LayerBuffer& l : g_layers) {
            for (const TextLabel& label : l.labels) {
                if (!contains_ci(label.text, needle)) continue;
                total++;
                if ((unsigned)emitted >= limit) continue;
                val obj = val::object();
                obj.set("text", label.text);
                obj.set("x", (double)label.x);
                obj.set("y", (double)label.y);
                obj.set("layer", l.layer);
                obj.set("datatype", l.datatype);
                auto it = g_lyp_info.find(l.tag());
                obj.set("name", it != g_lyp_info.end() ? it->second.name : std::string());
                obj.set("visible", l.visible);
                hits.set(emitted++, obj);
            }
        }
    }

    out.set("total", (double)total);
    out.set("hits", hits);
    return out;
}


void setShowInfill(bool show) {
    g_show_infill = show;
    request_redraw();
}

// The panel's "Text" checkbox: draw GDSII/OASIS labels over the geometry (see
// draw_text). Pure render state -- the labels themselves are held from the
// moment the layout loads, so toggling never re-parses anything.
void setShowText(bool show) {
    if (g_show_text == show) return;
    g_show_text = show;
    g_text_dirty = true;
    request_redraw();
}

// The dat.gui "Merge Overlaps" checkbox -- see g_merge_mode/draw_layer_merged.
void setMergeMode(bool on) {
    g_merge_mode = on;
    request_redraw();
}

// The panel's "Grid" checkbox: the background reference grid (see draw_grid).
void setShowGrid(bool show) {
    g_show_grid = show;
    request_redraw();
}

// VS Code's active theme, pushed in by viewer.js's theme block on startup and
// on every theme change (see g_light_theme). Layers are recolored rather than
// re-uploaded: only the fallback palette changes, and it's a function of the
// layer/datatype pair, so no geometry is touched. Callers that render the
// panel need to re-read getLayers() afterwards for the row color chips.
void setTheme(bool light) {
    g_light_theme = light;
    g_bg_color = light ? std::array<float, 3>{0.98f, 0.98f, 0.985f}
                       : std::array<float, 3>{0.06f, 0.06f, 0.07f};
    g_ink_color = light ? std::array<float, 3>{0.08f, 0.08f, 0.10f}
                        : std::array<float, 3>{1.0f, 1.0f, 1.0f};
    g_highlight_color = light ? std::array<float, 3>{0.12f, 0.44f, 0.82f}
                              : std::array<float, 3>{0.29f, 0.62f, 1.0f};
    for (LayerBuffer& layer : g_layers) resolve_layer_colors(layer);
    request_redraw();
}

// Drops every ruler, finished or half-placed. The panel's "Clear rulers" row,
// and every path where a new file replaces the geometry the rulers referred to.
void clearMeasurements() {
    g_measurements.clear();
    g_measure_pending = false;
    g_snap_active = false;
    // No DOM in headless (plain Node) runs -- mirror loadAndRenderGds's guard.
    if (!g_gl_ready) return;
    // draw_frame early-returns with no layers, so it can't take the labels down
    // itself in the load-error path -- do it directly.
    update_measure_labels();
    request_redraw();
}

// What Escape means for the ruler, in one call so the two halves can't drift
// apart: abandon the measurement being placed, or -- if there wasn't one --
// clear the finished ones. Two steps rather than one because a ruler you are
// halfway through placing is a mistake to back out of, while the ones already
// down are work you may well want to keep -- one key shouldn't do both. Returns
// which of the two it did, so the caller can leave measure mode only on the
// press that had nothing left to cancel.
bool escapeMeasure() {
    const bool cancelled_pending = g_measure_pending;
    if (cancelled_pending) g_measure_pending = false;
    else g_measurements.clear();
    g_snap_active = false;
    if (g_gl_ready) {
        update_measure_labels();
        request_redraw();
    }
    return cancelled_pending;
}

int measurementCount() {
    return (int)g_measurements.size();
}

// Ruler on/off -- i.e. measure mode vs pan mode (the Pan | Measure row / M
// key in viewer.js). While on, canvas clicks measure instead of pan (see
// on_mousedown); wheel zoom still works. The crosshair cursor is the mode's
// visual cue on the canvas itself.
//
// Leaving the mode drops the half-placed ruler but keeps the finished ones: a
// completed measurement is an annotation on the layout, not part of a mode you
// happen to be in, and having to stay in measure mode to keep looking at one
// was the whole reason only a single ruler ever existed.
void setMeasureMode(bool on) {
    g_measure_mode = on;
    g_dragging = false;
    if (!on) {
        g_measure_pending = false;
        g_snap_active = false;
        if (g_gl_ready) {
            update_measure_labels();
            request_redraw();
        }
    }
    if (!g_gl_ready) return;  // no DOM in headless (plain Node) runs
    val canvas = val::global("document").call<val>("getElementById", std::string("glCanvas"));
    if (!canvas.isNull() && !canvas.isUndefined()) {
        canvas["style"].set("cursor", std::string(on ? "crosshair" : "default"));
    }
}

// Replaces all marker state with the flattened payload built by
// flattenMarkerModel() (marker-parsers.js): plain typed arrays, one bulk
// convertJSArrayToNumberVector copy each -- no chatty per-item objects across
// the boundary (same convention as uploadLayers). CPU-side state is populated
// unconditionally so headless Node runs work; GL work is deferred to the
// lazy rebuild in draw_markers() (request_redraw() is a no-op headlessly).
void setMarkers(val data) {
    g_markers.poly_verts = convertJSArrayToNumberVector<float>(data["polyVerts"]);
    g_markers.poly_counts = convertJSArrayToNumberVector<uint32_t>(data["polyVertCounts"]);
    g_markers.poly_item_ids = convertJSArrayToNumberVector<uint32_t>(data["polyItemIds"]);
    g_markers.edge_verts = convertJSArrayToNumberVector<float>(data["edgeVerts"]);
    g_markers.edge_item_ids = convertJSArrayToNumberVector<uint32_t>(data["edgeItemIds"]);
    g_markers.item_category = convertJSArrayToNumberVector<int32_t>(data["itemCategory"]);
    g_markers.item_bboxes = convertJSArrayToNumberVector<float>(data["itemBBoxes"]);
    g_marker_categories.assign((size_t)data["categories"]["length"].as<unsigned>(), MarkerCategoryGL{});
    g_selected_marker = -1;
    g_markers_dirty = true;
    request_redraw();
}

void clearMarkers() {
    g_markers = MarkerGeom{};
    g_marker_categories.clear();
    g_selected_marker = -1;
    g_markers_dirty = false;
    // Safe headlessly: every buffer name is still 0 there, so no GL call runs.
    delete_marker_gl_buffers();
    request_redraw();
}

void setMarkerCategoryVisible(int category_index, bool visible) {
    if (category_index < 0 || (size_t)category_index >= g_marker_categories.size()) return;
    if (g_marker_categories[(size_t)category_index].visible == visible) return;
    g_marker_categories[(size_t)category_index].visible = visible;
    g_markers_dirty = true;
    request_redraw();
}

void setSelectedMarker(int item_id) {
    if (g_selected_marker == item_id) return;
    g_selected_marker = item_id;
    g_markers_dirty = true;
    request_redraw();
}

// Overall marker-overlay opacity, 0..1 (the panel's Opacity slider). A pure
// draw-time alpha scale -- no VBO rebuild.
void setMarkerOpacity(double opacity) {
    float value = (float)std::clamp(opacity, 0.0, 1.0);
    if (value == g_marker_opacity) return;
    g_marker_opacity = value;
    request_redraw();
}

// Frames the camera on a world-space box with 4x padding -- used by the
// marker browser's item rows (and reusable for a future "zoom to all
// markers"). Degenerate axes (points, axis-aligned edges) only need an
// epsilon to keep the division finite: a zero-width axis then contributes an
// astronomical zoom candidate that either loses the min() to the real axis
// (an edge) or -- for a pure point -- gets capped by clamp_zoom_value's
// kMaxZoomPxPerUm ceiling, which is exactly the "as close as the camera goes"
// framing a point marker wants. Anything larger here (an earlier version
// floored the box at 20px-at-fit-zoom worth of world space) swamps typical
// sub-µm DRC markers and leaves the view zoomed way out.
void zoomToBox(double min_x, double min_y, double max_x, double max_y) {
    if (!g_gl_ready) return;
    if (!std::isfinite(min_x) || !std::isfinite(min_y) || !std::isfinite(max_x) || !std::isfinite(max_y)) return;
    if (min_x > max_x || min_y > max_y) return;
    double w = std::max(max_x - min_x, 1e-9);
    double h = std::max(max_y - min_y, 1e-9);
    double zoom = std::min((double)g_canvas_width / w, (double)g_canvas_height / h) / 4.0;
    g_zoom = clamp_zoom_value((float)zoom);
    g_pan_x = (float)((min_x + max_x) * 0.5);
    g_pan_y = (float)((min_y + max_y) * 0.5);
    clamp_pan();
    update_scale_bar();
    request_redraw();
}

// Centers the view on a world coordinate without changing the zoom -- the
// panel's "Go to (x, y)" box, whose whole purpose is pasting a coordinate out
// of a DRC report or a Slack message. Zoom is deliberately left alone: the
// caller knows the coordinate, not how much around it they want to see, and
// re-framing would throw away a zoom level they had already chosen.
//
// Returns whether the point actually ended up on screen. clamp_pan keeps the
// camera within reach of the design's bbox, so a coordinate from a different
// file (or a typo with an extra digit) silently parks the view at the nearest
// edge of the layout; saying so is the difference between "that point isn't in
// this design" and an unexplained jump to a corner.
bool goToPoint(double x, double y) {
    if (!g_gl_ready) return false;
    if (!std::isfinite(x) || !std::isfinite(y)) return false;
    g_pan_x = (float)x;
    g_pan_y = (float)y;
    clamp_pan();
    update_scale_bar();
    request_redraw();
    float half_w = (float)g_canvas_width * 0.5f / g_zoom;
    float half_h = (float)g_canvas_height * 0.5f / g_zoom;
    return std::fabs((double)g_pan_x - x) <= (double)half_w &&
           std::fabs((double)g_pan_y - y) <= (double)half_h;
}

// Drops the fading crosshair on a world coordinate (see draw_goto_flash). Its
// own call rather than part of goToPoint, because the two callers of the pan
// want different marks: "Go to Coordinate" has nothing but the coordinate to
// point at, while a label search already leaves its own box around the label it
// found, and two annotations on one spot say no more than one does.
void flashPoint(double x, double y) {
    if (!g_gl_ready) return;
    if (!std::isfinite(x) || !std::isfinite(y)) return;
    g_goto_x = (float)x;
    g_goto_y = (float)y;
    // performance.now(), the same clock the rAF timestamps draw_goto_flash
    // compares against come from.
    g_goto_start_ms = emscripten_get_now();
    request_redraw();
}

// Outlines world-space boxes on the canvas -- one per placement of the cell the
// hierarchy panel has selected (see syncCellHighlight in viewer.js), as a flat
// [minX, minY, maxX, maxY, ...] array. The selected row supplies them: a row
// stands for a cell as one parent places it, so a cell placed 40 times hands
// over 40 boxes and each copy is outlined where it actually sits. Rows whose
// placement count is over the tree's cap (kMaxRowPlacements) pass the single box
// spanning all of them instead, which is all build_hierarchy kept for them.
//
// Non-finite and inverted boxes are dropped individually rather than failing the
// whole call: they can only come from a degenerate cell in the file, and one bad
// placement shouldn't cost the outlines around its sound siblings.
void setCellHighlight(val boxes) {
    std::vector<float> flat = convertJSArrayToNumberVector<float>(boxes);
    g_highlight_boxes.clear();
    g_highlight_boxes.reserve(flat.size());
    for (size_t i = 0; i + 3 < flat.size(); i += 4) {
        float min_x = flat[i], min_y = flat[i + 1], max_x = flat[i + 2], max_y = flat[i + 3];
        if (!std::isfinite(min_x) || !std::isfinite(min_y) || !std::isfinite(max_x) ||
            !std::isfinite(max_y)) {
            continue;
        }
        if (min_x > max_x || min_y > max_y) continue;
        g_highlight_boxes.insert(g_highlight_boxes.end(), {min_x, min_y, max_x, max_y});
    }
    request_redraw();
}

void clearCellHighlight() {
    if (g_highlight_boxes.empty()) return;
    g_highlight_boxes.clear();
    request_redraw();
}

// CPU-side marker state summary for headless smoke tests (no GL context
// needed) -- see test/marker-wasm.test.js.
val getMarkerStats() {
    val stats = val::object();
    stats.set("items", (int)g_markers.item_category.size());
    stats.set("polygons", (int)g_markers.poly_counts.size());
    stats.set("edges", (int)g_markers.edge_item_ids.size());
    stats.set("categories", (int)g_marker_categories.size());
    int visible = 0;
    for (const MarkerCategoryGL& c : g_marker_categories) {
        if (c.visible) visible++;
    }
    stats.set("categoriesVisible", visible);
    stats.set("selected", g_selected_marker);
    stats.set("opacity", (double)g_marker_opacity);
    return stats;
}

int main() {
    g_gl_ready = init_gl();
    if (!g_gl_ready) return 0;
    emscripten_set_mousedown_callback("#glCanvas", nullptr, false, on_mousedown);
    emscripten_set_mousemove_callback("#glCanvas", nullptr, false, on_mousemove);
    emscripten_set_mouseup_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, nullptr, false, on_mouseup);
    emscripten_set_mouseleave_callback("#glCanvas", nullptr, false, on_mouseleave);
    emscripten_set_wheel_callback("#glCanvas", nullptr, false, on_wheel);
    emscripten_set_resize_callback(EMSCRIPTEN_EVENT_TARGET_WINDOW, nullptr, false, on_resize);
    resize_canvas();
    return 0;
}

EMSCRIPTEN_BINDINGS(gdstk_renderer_module) {
    function("loadAndRenderGds", &loadAndRenderGds);
    function("parseGdsToLayers", &parseGdsToLayers);
    function("uploadLayers", &uploadLayers);
    function("showLoadError", &showLoadError);
    function("loadLypText", &loadLypText);
    function("getLayers", &getLayers);
    function("findLabels", &findLabels);
    function("setLayerVisible", &setLayerVisible);
    function("resetView", &reset_view);
    function("getCamera", &getCamera);
    function("setCamera", &setCamera);
    function("setShowInfill", &setShowInfill);
    function("setShowText", &setShowText);
    function("setMergeMode", &setMergeMode);
    function("setShowGrid", &setShowGrid);
    function("setTheme", &setTheme);
    function("setMeasureMode", &setMeasureMode);
    function("clearMeasurements", &clearMeasurements);
    function("escapeMeasure", &escapeMeasure);
    function("measurementCount", &measurementCount);
    function("setMarkers", &setMarkers);
    function("clearMarkers", &clearMarkers);
    function("setMarkerCategoryVisible", &setMarkerCategoryVisible);
    function("setSelectedMarker", &setSelectedMarker);
    function("setMarkerOpacity", &setMarkerOpacity);
    function("zoomToBox", &zoomToBox);
    function("goToPoint", &goToPoint);
    function("flashPoint", &flashPoint);
    function("setCellHighlight", &setCellHighlight);
    function("clearCellHighlight", &clearCellHighlight);
    function("getMarkerStats", &getMarkerStats);
    function("getCoordinateTextAt", &getCoordinateTextAt);
}
