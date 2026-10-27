#!/usr/bin/env python3
"""Regenerate the FILES list in install.py from the repository tree.

weectl keeps a copy of install.py and re-imports it to uninstall, away from
the skin files, so the list of installed files has to be static.

    python tools/gen_filelist.py          # rewrite install.py
    python tools/gen_filelist.py --check  # exit 1 if install.py is stale
"""

import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INSTALL = os.path.join(REPO, 'install.py')
ROOTS = ['bin/user', 'skins/jhwx']
INCLUDE_BIN = ('jhwx.py', 'jhwx_fire.py', 'jhwx_history.py', 'jhwx_lightning.py', 'jhwx_mslp.py')


def tree():
    groups = {}
    for root in ROOTS:
        for dirpath, dirs, names in os.walk(os.path.join(REPO, root)):
            dirs[:] = sorted(d for d in dirs if d != '__pycache__')
            rel = os.path.relpath(dirpath, REPO).replace(os.sep, '/')
            for n in sorted(names):
                if n.endswith(('.pyc', '.pyo')):
                    continue
                if rel == 'bin/user' and n not in INCLUDE_BIN:
                    continue
                groups.setdefault(rel, []).append('%s/%s' % (rel, n))
    return sorted(groups.items())


def render(groups):
    lines = ['FILES = [']
    for d, files in groups:
        lines.append('    (%r, [' % d)
        lines.extend('        %r,' % f for f in files)
        lines.append('    ]),')
    lines.append(']')
    return '\n'.join(lines)


def main():
    src = open(INSTALL, encoding='utf-8').read()
    new_block = render(tree())
    pat = re.compile(r'^FILES = \[\n.*?^\]$', re.S | re.M)
    if not pat.search(src):
        sys.exit('install.py has no FILES = [...] block')
    new_src = pat.sub(lambda _m: new_block, src)
    if '--check' in sys.argv:
        if new_src != src:
            print('install.py FILES is out of date: run tools/gen_filelist.py')
            sys.exit(1)
        print('install.py FILES is up to date')
        return
    with open(INSTALL, 'w', encoding='utf-8', newline='\n') as f:
        f.write(new_src)
    print('wrote %d directories, %d files' % (len(tree()), sum(len(f) for _, f in tree())))


if __name__ == '__main__':
    main()
