// Paste into browser console on your LinkedIn profile page.
// Extracts full profile data via Voyager GraphQL, saves as JSON.
//
// Query IDs are hashes of LinkedIn's GraphQL queries. They rotate when
// LinkedIn updates their frontend. To fix: open Network tab, find the
// failing request, grab the new hash from queryId=, update here.
const QUERY_IDS = {
  PROFILE_LOOKUP:  'voyagerIdentityDashProfiles.a1a483e719b20537a256b6853cdca711',
  PROFILE_CARDS:   'voyagerIdentityDashProfileCards.ef04d8d8a644bb1271d8640b7fd373d3',
  PROFILE_CARDS_2: 'voyagerIdentityDashProfileCards.55af784c21dc8640b500ab5b45937064',
  SECTION:         'voyagerIdentityDashProfileComponents.c5d4db426a0f8247b8ab7bc1d660775a',
  SECTION_PAGE:    'voyagerIdentityDashProfileComponents.1ad109a952e36585fdc2e7c2dedcc357',
};

const SECTION_SLUGS = {
  'Education': 'education',
  'Courses': 'courses',
  'Honors & awards': 'honors',
  'Languages': 'languages',
  'Publications': 'publications',
  'Volunteering': 'volunteering-experiences',
  'Projects': 'projects',
  'Licenses & certifications': 'certifications',
  'Featured': 'featured',   // 200 on 2026-09-12; empty until a card exists
};

(async () => {
  try {
    const csrf = document.cookie.match(/JSESSIONID="?([^";]+)/)?.[1];
    const vanity = location.pathname.match(/\/in\/([^/]+)/)?.[1];
    if (!csrf || !vanity) return console.error('Navigate to /in/yourname first');

    // Non-OK responses degrade to an empty section rather than aborting, so
    // one rotated query ID does not lose the whole export. They are recorded
    // in the output as `warnings`; the console alone is invisible to the
    // node harness.
    const warnings = [];
    const get = (url) => fetch(url, {
      headers: {
        'csrf-token': csrf,
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'x-restli-protocol-version': '2.0.0'
      }
    }).then(r => {
      if (!r.ok) {
        const endpoint = url.split('?')[0];
        const hint = url.match(/sectionType:(\w+)/)?.[1]
          || url.match(/queryId=\w+\.(\w+)/)?.[1]
          || '';
        warnings.push(`API ${r.status}: ${endpoint}...${hint}`);
        console.warn(warnings[warnings.length - 1]);
        return { included: [], data: {} };
      }
      return r.json();
    });

    // --- Parsing ---

    const parseEntity = (ec) => {
      if (!ec) return null;
      const entry = {};
      const title = ec.titleV2?.text?.text || ec.title?.text || '';
      const subtitle = ec.subtitle?.text || '';
      const caption = ec.caption?.text || '';
      const meta = ec.metadata?.text || '';
      if (title) entry.title = title;
      if (subtitle) entry.subtitle = subtitle;
      if (caption) entry.dates = caption;
      if (meta) entry.location = meta;

      const descriptions = [];
      const skillTexts = [];
      const children = [];

      const collectText = (text) => {
        if (text.startsWith('Skills: ')) {
          skillTexts.push(...text.slice(8).split(' · '));
        } else {
          descriptions.push(text);
        }
      };

      const collectComponents = (components) => {
        const sc = components || {};
        if (sc.textComponent?.text?.text) collectText(sc.textComponent.text.text);
        if (sc.entityComponent) {
          const child = parseEntity(sc.entityComponent);
          if (child) children.push(child);
        }
      };

      for (const sub of (ec.subComponents?.components || [])) {
        collectComponents(sub.components);
        for (const nc of (sub.components?.fixedListComponent?.components || [])) {
          collectComponents(nc.components);
        }
      }

      if (descriptions.length) entry.description = descriptions.join('\n').replace(/\n{3,}/g, '\n\n');
      if (skillTexts.length) entry.skills = skillTexts;
      if (children.length) entry.roles = children;
      return Object.keys(entry).length ? entry : null;
    };

    const parseElements = (elements) => {
      const items = [];
      for (const el of elements) {
        const sc = el.components || {};
        if (sc.entityComponent) {
          const parsed = parseEntity(sc.entityComponent);
          if (parsed) items.push(parsed);
        } else if (sc.textComponent?.text?.text) {
          items.push({ title: sc.textComponent.text.text });
        }
      }
      return items;
    };

    // --- Shared fetching ---

    const encodePlcUrn = (entityUrn) =>
      encodeURIComponent(entityUrn).replace(/\(/g, '%28').replace(/\)/g, '%29');

    // Fetch a section and return all PagedListComponents from the response
    const fetchSectionPlcs = async (sectionType) => {
      const resp = await get(
        `/voyager/api/graphql?variables=(profileUrn:${urn},sectionType:${sectionType})&queryId=${QUERY_IDS.SECTION}`
      );
      return (resp.included || []).filter(i => i.$type?.includes('PagedListComponent'));
    };

    const dedupKey = (item) => item.title + '|' + (item.dates || '');

    const dedupInto = (items, seen, newItems) => {
      for (const item of newItems) {
        const key = dedupKey(item);
        if (!seen.has(key)) { seen.add(key); items.push(item); }
      }
    };

    // Paginate a single PLC, collecting parsed items with dedup
    const paginatePlc = async (plc, seen = new Set()) => {
      const elements = plc.components?.elements || [];
      const paging = plc.components?.paging || {};
      const total = paging.total || elements.length;

      const items = [];
      dedupInto(items, seen, parseElements(elements));

      if (elements.length < total && plc.entityUrn) {
        const plcUrn = encodePlcUrn(plc.entityUrn);
        let start = elements.length;
        while (start < total) {
          const page = await get(
            `/voyager/api/graphql?variables=(start:${start},count:20,paginationToken:null,pagedListComponent:${plcUrn})&queryId=${QUERY_IDS.SECTION_PAGE}`
          );
          const els = page.data?.data?.identityDashProfileComponentsByPagedListComponent?.elements || [];
          if (els.length === 0) break;
          const before = items.length;
          dedupInto(items, seen, parseElements(els));
          console.log(`    page start:${start} -> ${els.length} elements, ${items.length - before} new`);
          start += els.length;
        }
      }

      return { items, total };
    };

    // --- Step 1: Profile URN ---
    console.log('Fetching profile URN...');
    const profileResp = await get(
      `/voyager/api/graphql?variables=(vanityName:${vanity})&queryId=${QUERY_IDS.PROFILE_LOOKUP}`
    );
    const profileUrn = profileResp.data?.data?.identityDashProfilesByMemberIdentity?.['*elements']?.[0];
    if (!profileUrn) return console.error('Could not resolve profile URN', profileResp);
    const urn = encodeURIComponent(profileUrn);
    console.log('URN:', profileUrn);

    // --- Step 2+3: Name + headline, About + Causes (parallel) ---
    console.log('Fetching profile cards...');
    const [infoResp, cardsResp] = await Promise.all([
      get(`/voyager/api/graphql?variables=(profileUrn:${urn})&queryId=${QUERY_IDS.PROFILE_CARDS}`),
      get(`/voyager/api/graphql?variables=(profileUrn:${urn})&queryId=${QUERY_IDS.PROFILE_CARDS_2}`),
    ]);
    // The vanity lookup carries the full Profile record for the target. The
    // cards responses carry it fully only for your own profile; for anyone
    // else it is a 4-key stub, so search the lookup first.
    const isTarget = (i) => i.$type?.includes('Profile') && i.entityUrn === profileUrn;
    const me = [profileResp, infoResp, cardsResp]
      .flatMap(r => r.included || [])
      .find(i => isTarget(i) && i.firstName);
    const textSections = {};
    for (const item of (cardsResp.included || [])) {
      const tc = item.topComponents;
      if (!tc) continue;
      const header = tc[0]?.components?.headerComponent?.title?.text;
      const text = tc[1]?.components?.textComponent?.text?.text;
      if (header && text) textSections[header] = text;
    }

    // --- Step 4: Paginated section fetcher ---
    const fetchPagedList = async (sectionType, label = sectionType) => {
      console.log(`Fetching ${label}...`);
      const plcs = await fetchSectionPlcs(sectionType);
      const plc = plcs.find(p => p.decorationType === 'LINE_SEPARATED') || plcs[0];
      if (!plc) return [];

      const { items, total } = await paginatePlc(plc);
      console.log(`  ${sectionType}: ${items.length}/${total}`);
      return items;
    };

    // --- Step 5: Experience (grouped roles need special handling) ---
    const fetchExperience = async () => {
      console.log('Fetching experience...');
      const plcs = await fetchSectionPlcs('experience');
      const mainPlc = plcs.find(p => p.decorationType === 'LINE_SEPARATED');
      if (!mainPlc) return [];

      const rawElements = mainPlc.components?.elements || [];
      const entries = parseElements(rawElements);

      // Sub-role PLCs: NONE type with profilePositionGroup in entityUrn.
      // Match each to its group container by position group ID.
      const subRolePlcs = plcs.filter(p =>
        p.decorationType === 'NONE' && p.entityUrn?.includes('profilePositionGroup')
      );
      for (const plc of subRolePlcs) {
        const groupId = plc.entityUrn?.match(/fsd_profilePositionGroup:([^)]+)/)?.[1];
        if (!groupId) continue;

        let matched = false;
        for (let i = 0; i < rawElements.length; i++) {
          if (JSON.stringify(rawElements[i]).includes(groupId)) {
            const detailed = parseElements(plc.components?.elements || []);
            for (const role of detailed) role.company = entries[i].title;
            entries[i].roles = detailed;
            console.log(`    ${entries[i].title}: ${detailed.length} sub-roles matched by positionGroup`);
            matched = true;
            break;
          }
        }
        if (!matched) console.warn(`    Unmatched positionGroup: ${groupId}`);
      }

      const paging = mainPlc.components?.paging || {};
      console.log(`  experience: ${entries.length}/${paging.total || entries.length} top-level (${subRolePlcs.length} grouped companies)`);
      return entries;
    };

    // --- Step 6: Skills (collect from ALL category PLCs, dedup across them) ---
    const fetchSkills = async () => {
      console.log('Fetching skills...');
      const plcs = await fetchSectionPlcs('skills');
      const allSkills = [];
      const seen = new Set();
      for (const plc of plcs) {
        const { items } = await paginatePlc(plc, seen);
        allSkills.push(...items);
      }
      console.log(`  skills: ${allSkills.length} unique from ${plcs.length} category PLCs`);
      return allSkills;
    };

    // --- Step 7: Recommendations (separate PLCs for received/given/pending) ---
    const fetchRecommendations = async () => {
      console.log('Fetching recommendations...');
      const plcs = await fetchSectionPlcs('recommendations');
      const tabFragments = {
        RECEIVED_RECOMMENDATIONS: 'received',
        GIVEN_RECOMMENDATIONS: 'given',
        PENDING_RECOMMENDATIONS: 'pending',
      };
      const recs = {};
      for (const plc of plcs) {
        const tab = Object.entries(tabFragments).find(([frag]) => plc.entityUrn?.includes(frag));
        const label = tab?.[1] || `tab_${Object.keys(recs).length}`;
        const items = parseElements(plc.components?.elements || []);
        if (items.length) recs[label] = items;
      }
      if (Object.keys(recs).length) {
        console.log(`  recommendations: ${Object.entries(recs).map(([k, v]) => `${k}:${v.length}`).join(', ')}`);
      } else {
        console.log('  recommendations: empty or not found');
      }
      return recs;
    };

    // --- Step 8: Fetch all sections in parallel, then assemble ---
    console.log('Fetching all sections in parallel...');
    const [experience, skills, recs, ...sectionResults] = await Promise.all([
      fetchExperience(),
      fetchSkills(),
      fetchRecommendations(),
      ...Object.entries(SECTION_SLUGS).map(([name, slug]) =>
        fetchPagedList(slug, name)
          .then(items => ({ name, items }))
          .catch(err => { console.warn(`  ${name} failed, skipping:`, err.message); return null; })
      )
    ]);

    const profile = {
      name: me ? `${me.firstName} ${me.lastName}` : vanity,
      headline: me?.headline || '',
      vanityName: vanity,
      profileUrn,
      exportedAt: new Date().toISOString(),
      sections: {}
    };

    if (textSections['About']) profile.sections['About'] = textSections['About'];
    if (textSections['Causes']) profile.sections['Causes'] = textSections['Causes'];

    profile.sections['Experience'] = experience;
    profile.sections['Skills'] = skills;
    if (Object.keys(recs).length) profile.sections['Recommendations'] = recs;

    for (const result of sectionResults) {
      if (result && result.items.length) profile.sections[result.name] = result.items;
      else if (result) console.log(`  ${result.name}: empty or not found`);
    }
    if (warnings.length) profile.warnings = warnings;

    // --- Step 9: Output ---
    const output = JSON.stringify(profile, null, 2);
    console.log(`\nExport complete: ${Object.keys(profile.sections).length} sections`);
    for (const [k, v] of Object.entries(profile.sections)) {
      if (Array.isArray(v)) {
        console.log(`  ${k}: ${v.length} items`);
      } else if (typeof v === 'string') {
        console.log(`  ${k}: ${v.length} chars`);
      } else {
        const detail = Object.entries(v).map(([sk, sv]) => `${sk}:${sv.length}`).join(', ');
        console.log(`  ${k}: ${detail}`);
      }
    }

    const blob = new Blob([output], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `linkedin-${vanity}-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    console.log('Download started!');
  } catch (err) {
    console.error('Export failed:', err);
  }
})();
