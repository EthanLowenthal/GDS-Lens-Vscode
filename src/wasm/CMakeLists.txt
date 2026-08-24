# Builds gdstk + the qhull_r subset it needs + bindings.cpp into a single
# Emscripten module (gdstk_wasm.js, with the .wasm binary embedded as base64
# via SINGLE_FILE). Must be configured with `emcmake cmake`.
#
# gdstk's own CMakeLists.txt isn't reused here: it pulls in zlib/Qhull via
# find_package(), which assumes native installs (e.g. Homebrew) that aren't
# wasm32 binaries. Compiling gdstk's and qhull's sources directly into this
# target instead gives full control over the cross-compiled flags, and lets
# zlib come from Emscripten's built-in port (-sUSE_ZLIB=1) instead of a real
# system library.

cmake_minimum_required(VERSION 3.26)
project(gdstk_wasm LANGUAGES CXX C)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure this project with `emcmake cmake` (Emscripten not detected).")
endif()

# gdstk itself only requires C++11, but embind (used by bindings.cpp) needs
# C++17+; compiling everything at C++17 is fine since it's a superset.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 99)

set(GDSTK_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/gdstk")
set(QHULL_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/qhull")
# Header-only (mapbox/earcut.hpp); nothing to compile, just an include path.
set(EARCUT_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/earcut")

set(GDSTK_SOURCES
    "${GDSTK_DIR}/src/cell.cpp"
    "${GDSTK_DIR}/src/clipper_tools.cpp"
    "${GDSTK_DIR}/src/curve.cpp"
    "${GDSTK_DIR}/src/flexpath.cpp"
    "${GDSTK_DIR}/src/gdsii.cpp"
    "${GDSTK_DIR}/src/label.cpp"
    "${GDSTK_DIR}/src/layername.cpp"
    "${GDSTK_DIR}/src/library.cpp"
    "${GDSTK_DIR}/src/oasis.cpp"
    "${GDSTK_DIR}/src/polygon.cpp"
    "${GDSTK_DIR}/src/property.cpp"
    "${GDSTK_DIR}/src/raithdata.cpp"
    "${GDSTK_DIR}/src/rawcell.cpp"
    "${GDSTK_DIR}/src/reference.cpp"
    "${GDSTK_DIR}/src/repetition.cpp"
    "${GDSTK_DIR}/src/robustpath.cpp"
    "${GDSTK_DIR}/src/style.cpp"
    "${GDSTK_DIR}/src/utils.cpp"
    "${GDSTK_DIR}/external/clipper/clipper.cpp")

set(QHULL_SOURCES
    "${QHULL_DIR}/src/libqhull_r/geom2_r.c"
    "${QHULL_DIR}/src/libqhull_r/geom_r.c"
    "${QHULL_DIR}/src/libqhull_r/global_r.c"
    "${QHULL_DIR}/src/libqhull_r/io_r.c"
    "${QHULL_DIR}/src/libqhull_r/libqhull_r.c"
    "${QHULL_DIR}/src/libqhull_r/mem_r.c"
    "${QHULL_DIR}/src/libqhull_r/merge_r.c"
    "${QHULL_DIR}/src/libqhull_r/poly2_r.c"
    "${QHULL_DIR}/src/libqhull_r/poly_r.c"
    "${QHULL_DIR}/src/libqhull_r/qset_r.c"
    "${QHULL_DIR}/src/libqhull_r/random_r.c"
    "${QHULL_DIR}/src/libqhull_r/rboxlib_r.c"
    "${QHULL_DIR}/src/libqhull_r/stat_r.c"
    "${QHULL_DIR}/src/libqhull_r/user_r.c"
    "${QHULL_DIR}/src/libqhull_r/usermem_r.c"
    "${QHULL_DIR}/src/libqhull_r/userprintf_r.c"
    "${QHULL_DIR}/src/libqhull_r/userprintf_rbox_r.c")

add_executable(gdstk_wasm bindings.cpp renderer.cpp lyp_util.cpp stroke_font.cpp
    ${GDSTK_SOURCES} ${QHULL_SOURCES})

target_include_directories(gdstk_wasm PRIVATE
    "${GDSTK_DIR}/include"
    "${GDSTK_DIR}/external"
    "${QHULL_DIR}/src"
    "${EARCUT_DIR}/include")

set_source_files_properties(${QHULL_SOURCES} PROPERTIES LANGUAGE C)

target_compile_options(gdstk_wasm PRIVATE
    -O3
    -Wno-unused-parameter
    -sUSE_ZLIB=1)

target_link_options(gdstk_wasm PRIVATE
    -O3
    --bind
    -sUSE_ZLIB=1
    -sUSE_WEBGL2=1
    -sMIN_WEBGL_VERSION=2
    -sMAX_WEBGL_VERSION=2
    -sFULL_ES3=1
    # MODULARIZE without EXPORT_ES6 produces a plain global factory function
    # (createGdstkModule), loadable from a classic <script> tag in the
    # webview without needing type="module" + CSP changes for ES imports.
    -sMODULARIZE=1
    -sEXPORT_NAME=createGdstkModule
    -sSINGLE_FILE=1
    -sALLOW_MEMORY_GROWTH=1
    # Emscripten caps growth at 2GB by default; a big flattened layout hits
    # that and dies with a bare "memory access out of bounds". 4GB is the most
    # a wasm32 module can address, so this is the ceiling -- past it, loads
    # fail with the explicit message wasm-worker.js produces.
    -sMAXIMUM_MEMORY=4294967296
    -sENVIRONMENT=web,node
    -sEXPORTED_RUNTIME_METHODS=FS,ccall
    -sNO_EXIT_RUNTIME=1
    # embind's invoker functions are normally generated via `new Function(...)`
    # (a JS string-eval), which needs CSP 'unsafe-eval' -- 'wasm-unsafe-eval'
    # only covers WebAssembly bytecode generation, not this. DYNAMIC_EXECUTION=0
    # makes embind use a slower but eval-free invocation path instead, so the
    # webview's CSP can omit 'unsafe-eval' entirely.
    -sDYNAMIC_EXECUTION=0
    # gdstk's GDSII record reader keeps a stack buffer sized for the largest
    # possible record (64KB); the default 64KB Emscripten stack isn't enough
    # headroom on top of the rest of the call chain.
    -sSTACK_SIZE=8388608)

set_target_properties(gdstk_wasm PROPERTIES
    OUTPUT_NAME "gdstk_wasm"
    SUFFIX ".js")
