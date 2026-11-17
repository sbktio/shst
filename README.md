# shst

This repository currently pins [Tailcat](https://github.com/tailscale/tailcat) as a Git submodule. Tailcat provides netcat-like, point-to-point connections over Tailscale's open-source data plane without requiring the Tailscale control plane. It uses WireGuard-encrypted tunnels, attempts direct peer-to-peer connectivity, and falls back to DERP relays when necessary.

The submodule is located at [`package/tailcat`](package/tailcat) and is sourced from the [`sbktio/tailcat`](https://github.com/sbktio/tailcat) fork. Git records a specific Tailcat revision so that every checkout uses the same source.

## Clone

Clone the repository and initialize all submodules in one command:

```sh
git clone --recurse-submodules https://github.com/sbktio/shst.git
cd shst
```

If you already cloned the repository without submodules, initialize them afterward:

```sh
git submodule update --init --recursive
```

To restore the submodule to the revision pinned by this repository after making local changes or checking out another branch, run the same `git submodule update --init --recursive` command from the repository root.

## Repository layout

- `package/tailcat/` — pinned Tailcat source, including its Go library, CLI, web demo, tests, and documentation.
- `LICENSE` — license for this repository.
- `THIRDPARTYLICENSE` — Tailcat's required third-party copyright and license notice.

## Working with Tailcat

Tailcat is a Go module. Its current toolchain version is declared in [`package/tailcat/go.mod`](package/tailcat/go.mod). From the repository root, a typical test run is:

```sh
cd package/tailcat
go test ./...
```

The Tailcat project documents installation, usage, security considerations, and source builds in its own files:

- [Tailcat README](package/tailcat/README.md)
- [Installation and source-build instructions](package/tailcat/INSTALL.md)
- [Security policy and threat-model notes](package/tailcat/SECURITY.md)

For the recommended optimized CLI build, follow `package/tailcat/INSTALL.md`; its build-tag list is maintained by the Tailcat project.

## Licenses

The root repository is licensed under the MIT License; see [`LICENSE`](LICENSE). Tailcat is distributed under the BSD 3-Clause License. See [`THIRDPARTYLICENSE`](THIRDPARTYLICENSE) and [`package/tailcat/LICENSE`](package/tailcat/LICENSE).
