# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp==2.2.0", "PyYAML==6.0.3"]
# ///
"""The sole executable KB MCP entrypoint."""
from kb_mcp.server import main

if __name__ == '__main__':
    raise SystemExit(main())
