#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "mcp==2.2.0",
# ]
# ///

from libvirt_mcp.server import main


if __name__ == "__main__":
    main()
