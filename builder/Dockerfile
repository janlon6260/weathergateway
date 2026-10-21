# Legacy optional SDK image. Current Compose pulls Espressif directly and mounts
# the application-managed template. This Dockerfile is not used by publishing.
# Fixed SDK; the worker has no network, Docker socket, AD password or CA/signing key.
FROM espressif/idf:v6.1@sha256:81893c71bb5e570088901f21def8684c25cd2a9020281bd01b843a7655edb18c
USER root
RUN groupadd -g 70007 gateway && useradd -m -u 70001 -g 70007 gateway
WORKDIR /opt/wg-firmware
COPY firmware/ ./
# Resolve pinned managed components while building the Docker image, never at runtime.
RUN printf '#pragma once\n' > main/provisioning.h && touch main/ca.pem main/device.pem main/device.key && \
    /opt/esp/entrypoint.sh idf.py reconfigure && \
    mkdir -p components && mv managed_components/espressif__mqtt components/mqtt && mv managed_components/espressif__cjson components/cjson && \
    rm -rf build sdkconfig sdkconfig.old managed_components && rm -f main/provisioning.h main/ca.pem main/device.pem main/device.key && \
    chmod -R a+rX,u+w /opt/wg-firmware && mkdir /jobs /workspace && chown 70001:70007 /jobs /workspace
COPY builder/worker.py /opt/wg-builder/worker.py
ENV HOME=/tmp WG_BUILD_JOBS=/jobs WG_BUILD_WORK=/workspace WG_FIRMWARE_TEMPLATE=/opt/wg-firmware IDF_COMPONENT_MANAGER=0 IDF_PY_BUILD_JOBS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 PYTHONUTF8=1
USER 70001:70007
WORKDIR /workspace
CMD ["python", "/opt/wg-builder/worker.py"]
