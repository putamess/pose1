cmake_minimum_required(VERSION 3.21)
project(wintab_pointer_bridge LANGUAGES CXX)

if(NOT WIN32)
    message(FATAL_ERROR "wintab32.dll must be built on Windows.")
endif()
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
    message(FATAL_ERROR "This project targets 64-bit Photoshop CS6 only. Configure an x64 toolchain.")
endif()

if(MSVC)
    # Make the DLL self-contained instead of requiring a newer VC++ runtime beside Photoshop.
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

add_library(wintab32 SHARED
    wintab32.cpp
    wintab32.def
)

target_compile_features(wintab32 PRIVATE cxx_std_17)
target_compile_definitions(wintab32 PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    WINVER=0x0602
    _WIN32_WINNT=0x0602
)
target_include_directories(wintab32 PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(wintab32 PRIVATE user32 comctl32)
set_target_properties(wintab32 PROPERTIES
    PREFIX ""
    OUTPUT_NAME "wintab32"
    CXX_EXTENSIONS OFF
    WINDOWS_EXPORT_ALL_SYMBOLS OFF
)

if(MSVC)
    target_compile_options(wintab32 PRIVATE /W4 /permissive- /EHsc)
else()
    target_compile_options(wintab32 PRIVATE -Wall -Wextra -Wpedantic)
endif()
