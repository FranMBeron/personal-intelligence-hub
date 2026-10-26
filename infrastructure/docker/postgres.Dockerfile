FROM golang:1.26.9-alpine3.24@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS gosu-build

# Rebuild the same reviewed gosu source with a patched, fixed Go toolchain.
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go install github.com/tianon/gosu@6456aaa0f3c854d199d0f037f068eb97515b7513

FROM postgres:18.4-alpine3.24@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15

# Preserve the vendor entrypoint, user and data layout; refresh only reviewed libraries.
RUN apk add --no-cache libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 zlib=1.3.2-r1

COPY --from=gosu-build /go/bin/gosu /usr/local/bin/gosu
