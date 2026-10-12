FROM golang:1.27.0-alpine3.24@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS gosu-build

# Rebuild the same reviewed gosu source with a patched, fixed Go toolchain.
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go install github.com/tianon/gosu@6456aaa0f3c854d199d0f037f068eb97515b7513

FROM postgres:16.15-alpine3.24@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea

# Preserve the vendor entrypoint, user and data layout; refresh only reviewed libraries.
RUN apk add --no-cache libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 zlib=1.3.2-r1

COPY --from=gosu-build /go/bin/gosu /usr/local/bin/gosu
