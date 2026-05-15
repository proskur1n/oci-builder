# OCI Image Builder

A Node.js library for building and pushing container images without Docker.

This package is inspired by [jib](https://github.com/GoogleContainerTools/jib) (Java) and [ko](https://github.com/ko-build/ko) (Go).
It is also influenced by [google/nodejs-container-image-builder](https://github.com/google/nodejs-container-image-builder), which attempted a similar goal but relied on non-standard Docker Hub APIs and is now unmaintained.

`oci-builder` uses the [OCI Distribution Spec](https://github.com/opencontainers/distribution-spec/blob/main/spec.md) under the hood to communicate with registries.

## Installation

WARNING: This library is still in pre-release.
Breaking changes may occur without a major version bump.
It is highly recommended to install a concrete version for now.

```
npm install oci-builder@<version>
```

## Usage

```js
import { Builder } from "oci-builder";

// Images without an explicit registry (like node:current-slim) will be
// pulled/pushed from/to the default registry
// (configurable with `defaultRegistry`).
const builder = new Builder("node:current-slim"); // Specify the base image

builder.credentials = {
    // Empty string ("") is an alias for the default registry.
    "": {
        username: "myuser",
        password: "1234",
    },
    "registry.reset.inso-w.at": {
        username: "user123",
        password: "verysecret",
    }
};

builder.config = {
    WorkingDir: "/app",
    Entrypoint: ["node", "main.js"],
};

builder.addFiles([
    // The destination folder must end with "/". Otherwise, it will be
    // interpreted as a file.
    { src: ".", dst: "/app/" },
]);

await builder.push("registry.reset.inso-w.at/2026ss-ase-pr-group/26ss-ase-pr-inso-07/appname:tagname");
```