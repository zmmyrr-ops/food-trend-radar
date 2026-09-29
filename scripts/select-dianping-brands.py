"""Serial, resumable category popularity collection. Headers are JSON on stdin.

Select the first 100 distinct brands in popularity order, THEN require a deal
badge/link. Never reinterpret default order or review counts as popularity.
"""
import argparse
import datetime
import html
import http.client
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path


def norm(value):
    return ''.join(c for c in unicodedata.normalize('NFKC', value).lower()
                   if not unicodedata.category(c).startswith(('P', 'S'))
                   and not c.isspace() and c != '_')


def attrs(tag):
    return {k: html.unescape(v) for k, _, v in
            re.findall(r'([\w-]+)\s*=\s*(["\'])(.*?)\2', tag, re.S)}


def parse_page(body):
    anchors = [(attrs(tag), text) for tag, text in
               re.findall(r'<a\b([^>]+)>(.*?)</a>', body, re.S)]
    sort_verified = any(a.get('data-click-name') == 'sort_hot_click'
                        and 'cur' in a.get('class', '').split() for a, _ in anchors)
    title_match = re.search(r'<title[^>]*>(.*?)</title>', body, re.S | re.I)
    title = title_match.group(1) if title_match else ''
    blocked = any(x in title for x in ['验证', '403', '访问异常']) or '请求过于频繁' in body
    rows = []
    for block in re.findall(r'<li\b[^>]*>(.*?)</li>', body, re.S):
        h4 = re.search(r'<h4\b[^>]*>(.*?)</h4>', block, re.S)
        if not h4:
            continue
        links = [attrs(t) for t in re.findall(r'<a\b([^>]+)>', block, re.S)]
        shop = next((a for a in links if a.get('data-click-name') == 'shop_title_click'), None)
        if not shop or not re.match(r'https://www\.dianping\.com/shop/[\w]+$', shop.get('href', '')):
            continue
        # h4 can be visually truncated; the shop link's title contains the full name.
        name = shop.get('title') or html.unescape(re.sub('<[^>]+>', '', h4.group(1))).strip()
        deals = [{'url': a['href'], 'title': a.get('title', ''), 'marker': 'igroup'}
                 for a in links if 'igroup' in a.get('class', '').split()
                 and re.match(r'https?://t\.dianping\.com/deal/\d+', a.get('href', ''))]
        rows.append({'name': name, 'url': shop['href'], 'has_group_deal': bool(deals), 'deals': deals})
    page_links = [a.get('href', '') for a, _ in anchors
                  if re.search(r'/shanghai/ch10/g\d+o2p\d+$', a.get('href', ''))]
    return {'sort_verified': sort_verified, 'blocked': blocked, 'title': title,
            'shops': rows, 'page_links': page_links}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--policy', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    policy = json.loads(Path(args.policy).read_text())
    headers = json.load(sys.stdin)
    lookup = {norm(n): b['name'] for b in policy['known_brands'] for n in [b['name']] + b['aliases']}
    for name, canonical in policy['renames'].items():
        lookup[norm(name)] = lookup.get(norm(canonical), canonical)
    def brand_name(name):
        base = re.sub(r'[（(][^()（）]*[)）]$', '', name).strip()
        return lookup.get(norm(base), base)
    target = Path(args.output)
    output = json.loads(target.read_text()) if target.exists() else {
        'policy': policy['policy'], 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'categories': [], 'complete': False}
    opener = urllib.request.build_opener(NoRedirect())
    last_request = 0
    def fetch(url):
        nonlocal last_request
        for attempt in range(2):
            time.sleep(max(0, 2 - (time.monotonic() - last_request)))
            try:
                with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
                    body = response.read().decode('utf-8', 'replace')
                return body
            except http.client.IncompleteRead:
                if attempt:
                    raise
            finally:
                last_request = time.monotonic()
    def save():
        target.write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n')
    for category in policy['categories']:
        state = next((c for c in output['categories'] if c['id'] == category['id']), None)
        if state and state.get('complete'):
            continue
        if not state:
            state = {**category, 'pages': [], 'brands': [], 'complete': False}
            output['categories'].append(state)
        state.pop('error', None)
        if state.pop('refetch_last_page_on_resume', False):
            # Canonical review may merge brands and leave fewer than 100.
            # Re-read the last page because its tail was beyond the former cutoff.
            last_page = state['pages'].pop()['page']
            remaining = []
            for brand in state['brands']:
                shops = [s for s in brand['shops'] if s['page'] < last_page]
                if shops:
                    remaining.append({**brand, 'category_rank': len(remaining) + 1, 'shops': shops})
            state['brands'] = remaining
            save()
        seen = {norm(b['name']): b for b in state['brands']}
        page = len(state['pages']) + 1
        while page <= 50:
            url = category['url'] + 'o2' + ('p' + str(page) if page > 1 else '')
            try:
                parsed = parse_page(fetch(url))
                if parsed['blocked'] or not parsed['sort_verified'] or not parsed['shops']:
                    raise ValueError('verification_or_sort_not_confirmed_or_empty_page')
                previous_urls = {s['url'] for b in state['brands'] for s in b['shops']}
                if page > 1 and all(s['url'] in previous_urls for s in parsed['shops']):
                    raise ValueError('repeated_page_without_new_shops')
                for position, shop in enumerate(parsed['shops'], 1):
                    name = brand_name(shop['name'])
                    key = norm(name)
                    if key not in seen:
                        if len(state['brands']) >= policy['top_n']:
                            continue
                        brand = {'name': name, 'category_rank': len(state['brands']) + 1, 'shops': []}
                        seen[key] = brand
                        state['brands'].append(brand)
                    shop = {**shop, 'page': page, 'page_position': position, 'ranking_url': url}
                    if not any(s['url'] == shop['url'] for s in seen[key]['shops']):
                        seen[key]['shops'].append(shop)
                state['pages'].append({'page': page, 'url': url, 'shop_count': len(parsed['shops']),
                                       'sort_verified': True, 'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat()})
                has_next = any(re.search(r'p(\d+)$', link) and int(re.search(r'p(\d+)$', link).group(1)) > page
                               for link in parsed['page_links'])
                if len(state['brands']) >= policy['top_n']:
                    state.update(complete=True, stop_reason='top_100_distinct_brands')
                elif not has_next:
                    state.update(complete=True, stop_reason='visible_pagination_exhausted')
                elif page == 50:
                    state.update(complete=True, stop_reason='platform_50_page_limit')
                save()
                print(json.dumps({'category': category['name'], 'page': page, 'brands': len(state['brands']),
                                  'with_deal': sum(any(s['has_group_deal'] for s in b['shops']) for b in state['brands']),
                                  'complete': state['complete']}, ensure_ascii=False), flush=True)
                if state['complete']:
                    break
                page += 1
            except Exception as error:
                state['error'] = {'type': type(error).__name__, 'status': getattr(error, 'code', None),
                                  'reason': str(error) if isinstance(error, ValueError) else 'request_failed', 'page': page}
                save()
                print(json.dumps({'category': category['name'], 'error': state['error']}, ensure_ascii=False), flush=True)
                return
    output['complete'] = len(output['categories']) == len(policy['categories']) and all(c['complete'] for c in output['categories'])
    output['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    save()


if __name__ == '__main__':
    main()
