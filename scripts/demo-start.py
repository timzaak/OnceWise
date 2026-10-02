#!/usr/bin/env python
import argparse
import sys

from lib import demo_session
from lib.logger import Logger, LogLevel
from lib.paths import ensure_dir


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Start the oncewise-ai manual demo environment (build extension + oncewise-ai-sync + host pages + extension-loaded browser)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  uv run scripts/demo-start.py              # Full environment
  uv run scripts/demo-start.py --no-sync    # Skip oncewise-ai-sync backend (extension local-only mode)
  uv run scripts/demo-start.py --no-browser # Start services only, no browser launch
  uv run scripts/demo-start.py -v           # Verbose mode
        """,
    )

    verbosity_group = parser.add_mutually_exclusive_group()
    verbosity_group.add_argument(
        "-v", "--verbose",
        action="count",
        default=0,
        help="Increase verbosity (-v for verbose, -vv for debug)",
    )
    verbosity_group.add_argument(
        "-q", "--quiet",
        action="store_true",
        help="Quiet mode (errors only)",
    )

    parser.add_argument(
        "--backend-port",
        type=int,
        default=demo_session.DEFAULT_BACKEND_PORT,
        help=f"oncewise-ai-sync listen port (default: {demo_session.DEFAULT_BACKEND_PORT})",
    )
    parser.add_argument(
        "--host-port",
        type=int,
        default=demo_session.DEFAULT_HOST_PORT,
        help=f"Host test pages port (default: {demo_session.DEFAULT_HOST_PORT})",
    )
    parser.add_argument(
        "--debug-port",
        type=int,
        default=demo_session.DEFAULT_DEBUG_PORT,
        help=f"Browser remote debugging (CDP) port, loopback only (default: {demo_session.DEFAULT_DEBUG_PORT})",
    )
    parser.add_argument(
        "--no-remote-debugging",
        action="store_true",
        help="Do not open the browser remote debugging port",
    )
    parser.add_argument(
        "--no-build",
        action="store_true",
        help="Skip extension build (reuse existing .output/chrome-mv3)",
    )
    parser.add_argument(
        "--no-sync",
        action="store_true",
        help="Skip oncewise-ai-sync backend (no Rust toolchain needed)",
    )
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not launch the extension-loaded browser",
    )
    parser.add_argument(
        "--profile",
        action="store_true",
        help="Show detailed timing summary",
    )

    args = parser.parse_args()

    if args.quiet:
        level = LogLevel.QUIET
    elif args.verbose == 1:
        level = LogLevel.VERBOSE
    elif args.verbose >= 2:
        level = LogLevel.DEBUG
    else:
        level = LogLevel.NORMAL

    logger = Logger(level=level, profile=args.profile)
    ensure_dir(demo_session.LOG_DIR)

    try:
        success = demo_session.start_demo_session(
            logger,
            backend_port=args.backend_port,
            host_port=args.host_port,
            debug_port=None if args.no_remote_debugging else args.debug_port,
            build=not args.no_build,
            sync=not args.no_sync,
            browser=not args.no_browser,
        )
    except RuntimeError as exc:
        logger.error(str(exc))
        return 1
    except Exception as exc:  # noqa: BLE001 - top-level backstop so errors are always visible
        logger.error(f"Unexpected error: {exc}")
        return 1

    if args.profile:
        logger.print_summary()

    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
