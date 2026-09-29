"""Read Shanghai directory pages serially. Session headers arrive on stdin only.

Usage: python3 scripts/collect-dianping-directory.py --pages 11,15-49 --output PATH
Supply a JSON object of request headers on stdin; credentials are never persisted.
"""
import argparse
import datetime
import html
import http.client
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def parse_shops(body, page):
    rows = []
    for block in re.findall(r'<li\b[^>]*>(.*?)</li>', body, re.S):
        link = re.search(r'href=["\']((?:https?://(?:www\.)?dianping.com)?/shop/[^"\'?#/]+)', block)
        name = re.search(r'<h4\b[^>]*>(.*?)</h4>', block, re.S)
        if link and name:
            url = link.group(1)
            rows.append({
                'name': html.unescape(re.sub('<[^>]+>', '', name.group(1))).strip(),
                'url': url if url.startswith('http') else 'https://www.dianping.com' + url,
                'list_page': page,
            })
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pages', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    pages = []
    for segment in args.pages.split(','):
        bounds = [int(x) for x in segment.split('-')]
        pages.extend(range(bounds[0], bounds[-1] + 1))
    if not pages or any(p < 1 or p > 50 for p in pages):
        raise ValueError('Pages must be between 1 and 50')
    headers = json.load(sys.stdin)
    opener = urllib.request.build_opener(NoRedirect())
    output = {'source': 'https://www.dianping.com/shanghai/ch10',
              'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'complete_city_coverage': False, 'pages': [], 'shops': []}
    target = Path(args.output)
    for index, page in enumerate(dict.fromkeys(pages)):
        if index:
            time.sleep(2)
        url = output['source'] + '/p' + str(page)
        try:
            # Retry a truncated transport response once; never retry HTTP denials.
            for attempt in range(2):
                try:
                    with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
                        body = response.read().decode('utf-8', 'replace')
                        status = response.status
                    break
                except http.client.IncompleteRead:
                    if attempt:
                        raise
                    time.sleep(2)
            title_match = re.search(r'<title[^>]*>(.*?)</title>', body, re.S | re.I)
            title = html.unescape(title_match.group(1)).strip() if title_match else ''
            rows = parse_shops(body, page)
            blocked = any(x in title for x in ['验证', '403', '访问异常']) or any(x in body for x in ['请求过于频繁', '访问异常'])
            record = {'page': page, 'status': status, 'title': title, 'shop_count': len(rows), 'blocked': blocked}
            if blocked:
                output['stop_reason'] = 'verification_or_access_denied'
            elif not rows:
                output['stop_reason'] = 'empty_or_unrecognized_response'
            else:
                output['shops'].extend(rows)
        except Exception as error:
            record = {'page': page, 'status': getattr(error, 'code', None), 'error': type(error).__name__}
            output['stop_reason'] = 'request_error'
        output['pages'].append(record)
        target.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps(record, ensure_ascii=False), flush=True)
        if 'stop_reason' in output:
            break


if __name__ == '__main__':
    main()
