#!/usr/bin/env python3
"""Mint a passwordless magic-link (+ QR code) for the HuRI website demo.

The link is redeemed by the backend's ``/auth/magic`` route, which signs the
visitor in as the encoded identity WITHOUT a password. **Whoever scans the QR is
logged in as that identity**, so only ever encode a throwaway *demo* ``sub`` —
never a real user.

The signing secret must match the backend's ``MAGIC_LINK_SECRET`` (the value in
the ``magic_link_secret`` GCP Secret Manager secret, mounted into the website
pod as an env var). Pass it via ``--secret`` or the ``MAGIC_LINK_SECRET`` env var.

Usage::

    MAGIC_LINK_SECRET="$(gcloud secrets versions access latest --secret=magic_link_secret)" \\
      python make_magic_qr.py \\
        --origin https://app.huri.pommier.dev \\
        --sub demo-magic --email demo@example.com --name "Demo (QR)" \\
        --out magic-demo.png

Prints the URL and, if ``qrcode`` is installed, an ASCII QR to the terminal;
writes a PNG when ``--out`` is given (``pip install "qrcode[pil]"``).
"""

import argparse
import os
import sys

from itsdangerous import URLSafeTimedSerializer

# Must match MAGIC_LINK_SALT in ../main.py.
MAGIC_LINK_SALT = "huri-magic-login"


def build_url(origin: str, secret: str, sub: str, email: str, name: str) -> str:
    serializer = URLSafeTimedSerializer(secret, salt=MAGIC_LINK_SALT)
    token = serializer.dumps({"sub": sub, "email": email, "name": name})
    return f"{origin.rstrip('/')}/auth/magic?t={token}"


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--origin",
        required=True,
        help="Website origin, e.g. https://app.huri.pommier.dev",
    )
    p.add_argument(
        "--sub",
        default="demo-magic",
        help="Stable identity / RAG partition key to grant (default: demo-magic)",
    )
    p.add_argument("--email", default="demo@example.com")
    p.add_argument("--name", default="Demo (QR sign-in)")
    p.add_argument(
        "--secret",
        default=os.environ.get("MAGIC_LINK_SECRET", ""),
        help="Signing secret; defaults to $MAGIC_LINK_SECRET",
    )
    p.add_argument("--out", default="", help="Optional PNG path for the QR image")
    args = p.parse_args()

    if not args.secret:
        p.error("no signing secret: pass --secret or set MAGIC_LINK_SECRET")

    url = build_url(args.origin, args.secret, args.sub, args.email, args.name)
    print(url)

    try:
        import qrcode
    except ImportError:
        print(
            '\n(install "qrcode[pil]" to render a QR: pip install "qrcode[pil]")',
            file=sys.stderr,
        )
        return 0

    qr = qrcode.QRCode(border=2)
    qr.add_data(url)
    qr.make(fit=True)

    # Save the PNG first so a terminal that can't render the ASCII QR (e.g. a
    # Windows cp1252 console chokes on the █ block glyph) doesn't lose the image.
    if args.out:
        qr.make_image().save(args.out)
        print(f"Wrote {args.out}", file=sys.stderr)

    try:
        qr.print_ascii(invert=True)
    except UnicodeEncodeError:
        print(
            "(this terminal can't render the ASCII QR — use the PNG or the URL above)",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
