# Specman

A spec management tool for managing feature specifications, implementation, and validation.

## Overview

Specman helps you organize and manage feature specs throughout your development workflow.

## Getting Started

```bash
# Install dependencies (caches @std/assert, @std/yaml, @std/path)
deno install

# Run the CLI directly
deno run -A cli.ts

# Or use tasks defined in deno.json
deno task dev          # run with file watcher
deno task test         # run tests
deno task compile      # compile to standalone ./specman binary
```

## Compile to binary

```bash
deno task compile
./specman
```

## License

MIT
