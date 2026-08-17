#!/usr/bin/env python3
"""
deepcode X11 clipboard reader — one-shot read of the CLIPBOARD selection for
paste (Ctrl+V / right-click in the TUI) on sessions without xclip/xsel
(X11) or wl-paste (Wayland only). Prints the text to stdout and exits.

Exit codes: 0 = read attempted (text may be empty), 2 = environment unusable.
"""

import sys

try:
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk, GLib, Gtk
except Exception:  # noqa: BLE001 -- any import failure means "cannot help"
    sys.exit(2)

READ_TIMEOUT_SECONDS = 3


def main() -> int:
    display = Gdk.Display.get_default()
    if display is None:
        return 2

    clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
    state = {"text": None, "quit": False}

    def on_text(_clipboard, text, _data):
        state["text"] = text
        state["quit"] = True
        Gtk.main_quit()

    def on_timeout():
        state["quit"] = True
        Gtk.main_quit()
        return False

    clipboard.request_text(on_text, None)
    GLib.timeout_add_seconds(READ_TIMEOUT_SECONDS, on_timeout)
    Gtk.main()
    if state["text"]:
        sys.stdout.write(state["text"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
