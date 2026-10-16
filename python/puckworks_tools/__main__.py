# SPDX-License-Identifier: GPL-2.0-or-later
"""Allows ``python -m puckworks_tools``."""

import sys

from .cli import main

sys.exit(main())
