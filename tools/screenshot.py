"""Take a screenshot of the running dashboard (development helper).
usage: python3 tools/screenshot.py http://localhost:8787 out.png [wait_seconds]
"""
import sys, time
from playwright.sync_api import sync_playwright

url = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8787'
out = sys.argv[2] if len(sys.argv) > 2 else 'shot.png'
wait = float(sys.argv[3]) if len(sys.argv) > 3 else 6

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1920, 'height': 1080})
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    pg.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    pg.goto(url)
    time.sleep(wait)
    pg.screenshot(path=out)
    b.close()
    for l in logs[:30]:
        print(l)
    print('saved', out)
