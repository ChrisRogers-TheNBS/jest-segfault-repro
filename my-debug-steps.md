# Debug Steps Done

- Build NodeJS from source with ASan enabled

    ```shell
    git clone https://github.com/nodejs/node.git
    cd node
    git checkout v24.14.1

    # Configure with ASan
    ./configure \
        --debug \
        --enable-asan \
        CC=clang \
        CXX=clang++

    # Build
    make -j$(sysctl -n hw.logicalcpu)
    ```

- Symlink the ASan debug build of NodeJS into `nvm`

    ```shell
    # In the nodejs repo
    ln -s "$(readlink -f out/Debug/node)" ~/.nvm/versions/node/v24.14.1-asan/bin/node

    # Use existing release builds of `npm` and `npx`
    ln -s ~/.nvm/versions/node/v24.14.1/bin/npm ~/.nvm/versions/node/v24.14.1-asan/bin/npm
    ln -s ~/.nvm/versions/node/v24.14.1/bin/npx ~/.nvm/versions/node/v24.14.1-asan/bin/npx

    # Set ASan build as active node version on `nvm`
    nvm use v24.14.1-asan

    # Sanity check
    which node # Points to ~/.nvm/versions/node/v24.14.1-asan/bin/node
    node --version # Reports v24.14.1
    ```

- Build `unrs-resolver` from source with ASan enabled

    ```shell
    git clone https://github.com/unrs/unrs-resolver.git
    cd unrs-resolver
    git checkout v1.11.1

    # Install nightly and add rust-src (needed for -Zbuild-std)
    rustup toolchain install nightly
    rustup component add rust-src --toolchain nightly

    # Build the napi addon with ASan, nightly, no mimalloc
    RUSTFLAGS="-Zsanitizer=address -C force-frame-pointers=yes -C link-arg=-Wl,-ld_classic" \
        cargo +nightly build \
        --manifest-path napi/Cargo.toml \
        --target aarch64-apple-darwin \
        -Z build-std \
        --no-default-features
    ```

- Copy ASan build of `unrs-resolver` into project's `node_modules/`

    ```shell
    # In the unrs-resolver repo
    
    # Set project path
    PROJ_DIR=$HOME/repos/path/to/project

    ln -s "$(readlink -f target/aarch64-apple-darwin/debug/libunrs_resolver_napi.dylib)" "$PROJ_DIR/node_modules/unrs-resolver/resolver.darwin-arm64.node"
    ```
