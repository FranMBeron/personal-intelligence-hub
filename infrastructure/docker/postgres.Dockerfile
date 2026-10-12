FROM postgres:16.15-alpine3.24@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea

# Preserve the vendor entrypoint, user and data layout; refresh only reviewed libraries.
RUN apk add --no-cache libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 zlib=1.3.2-r1
