# fm-command-center

Web command center for firstmate: messages, decisions and work in one page.
Extracted from the [firstmate](https://github.com/talktejas/firstmate) repo so it can be developed and shipped on its own; it still reads and steers a firstmate home, and calls firstmate's own scripts by path rather than copying them.

Full behaviour, endpoints and what it stores: [docs/command-center.md](docs/command-center.md).

## Run it

```sh
python3 command-center.py --home /path/to/firstmate/home
```

Then open `http://127.0.0.1:8765`. Stdlib only — nothing to install.

`--firstmate-root <dir>` (default `/home/tds/p/firstmate`, or `$FM_FIRSTMATE_ROOT`) points at the firstmate checkout whose `bin/` scripts answer sends and capture messages; this repo never copies or edits them.

## Keep it running

```sh
python3 command-center.py --install-unit --home /path/to/firstmate/home
```

Writes `~/.config/systemd/user/firstmate-command-center.service` with this `ExecStart`:

```
ExecStart=/usr/bin/python3 /path/to/fm-command-center/command-center.py --port 8765 --home /path/to/firstmate/home --firstmate-root /home/tds/p/firstmate
```

Then, once you're ready to run it:

```sh
systemctl --user daemon-reload
systemctl --user enable --now firstmate-command-center
loginctl enable-linger "$USER"
```

## Tests

```sh
tests/command-center.test.sh
```

Runs against a throwaway firstmate home and a real firstmate checkout (`$FM_FIRSTMATE_ROOT`/`--firstmate-root`, default as above) for the scripts it calls out to.
