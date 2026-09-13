// Paste into browser console on any linkedin.com page while logged in.
// Lists your 1st-degree connections via the same Voyager call the
// /mynetwork/invite-connect/connections/ page makes while scrolling.
//
// decorationId is a versioned view name. If LinkedIn bumps it the request
// returns 400: open Network tab on the connections page, find the
// relationships/dash/connections request, copy its decorationId here.
const DECORATION_ID = 'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16';
const PAGE_SIZE = 40;          // what the UI asks for; larger values are refused
const PAGE_DELAY_MS = 800;     // roughly a scroll cadence

(async () => {
  try {
    const csrf = document.cookie.match(/JSESSIONID="?([^";]+)/)?.[1];
    if (!csrf) return console.error('Not logged in (no JSESSIONID cookie)');

    const headers = {
      'csrf-token': csrf,
      'accept': 'application/vnd.linkedin.normalized+json+2.1',
      'x-restli-protocol-version': '2.0.0',
    };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const connections = [];
    const seen = new Set();

    for (let start = 0; ; start += PAGE_SIZE) {
      const url = `/voyager/api/relationships/dash/connections?decorationId=${DECORATION_ID}` +
        `&count=${PAGE_SIZE}&q=search&sortType=RECENTLY_ADDED&start=${start}`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`API ${r.status} at start=${start}: ${(await r.text()).slice(0, 200)}`);
      const body = await r.json();

      const included = body.included || [];
      const byUrn = new Map(included.map((i) => [i.entityUrn, i]));
      const order = body.data?.['*elements'] || [];

      let added = 0;
      for (const connUrn of order) {
        const id = connUrn.split(':').pop();
        const conn = byUrn.get(connUrn) || {};
        const profile = byUrn.get(`urn:li:fsd_profile:${id}`);
        if (!profile || seen.has(id)) continue;
        seen.add(id);
        added++;
        connections.push({
          // Names arrive with stray double spaces; headlines with newlines.
          name: `${profile.firstName || ''} ${profile.lastName || ''}`.replace(/\s+/g, ' ').trim(),
          headline: (profile.headline || '').replace(/\s+/g, ' ').trim(),
          url: profile.publicIdentifier ? `https://www.linkedin.com/in/${profile.publicIdentifier}/` : '',
          connected_on: conn.createdAt ? new Date(conn.createdAt).toISOString().slice(0, 10) : '',
        });
      }
      console.log(`  start:${start} -> ${order.length} elements, ${added} new (total ${connections.length})`);
      // No total in the paging block, so a short page is the only end signal.
      // The harness compares the count against the previous file to catch a
      // truncated run.
      if (order.length < PAGE_SIZE) break;
      await sleep(PAGE_DELAY_MS);
    }

    const output = JSON.stringify({
      exportedAt: new Date().toISOString(),
      total: connections.length,
      connections,
    }, null, 2);
    console.log(`\nExport complete: ${connections.length} connections`);

    const blob = new Blob([output], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `linkedin-connections-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    console.log('Download started!');
  } catch (err) {
    console.error('Export failed:', err);
  }
})();
