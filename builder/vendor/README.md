# Locked firmware dependencies

ESP-MQTT 1.1.0 (Espressif, Apache-2.0) and cJSON 1.7.19~2 (MIT) are copied from the official Espressif Component Registry packages locked by `firmware/dependencies.lock`. Only runtime build sources, headers, CMake/Kconfig and license notices are included. Original license files are preserved in each directory.

Sources: https://components.espressif.com/components/espressif/mqtt/versions/1.1.0 and https://components.espressif.com/components/espressif/cjson/versions/1.7.19~2 .

`manifest.json` records the SHA-256 of each shipped source file. `prepare-builder.js` verifies these digests before publishing the offline firmware template. Changing dependencies requires updating the lock file, these sources and the manifest together, followed by a real ESP-IDF build locally. No package downloads occur inside the running firmware builder.
