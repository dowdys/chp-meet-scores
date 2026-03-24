import { chromeController } from '../chrome-controller';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../paths';
import { requireArray } from './validation';

/**
 * Build formatted level distribution lines from an array of athlete records.
 */
function formatLevelDistribution(athletes: unknown[]): string[] {
  const levelCounts: Record<string, number> = {};
  for (const a of athletes as Array<Record<string, string>>) {
    const level = a.level || 'UNKNOWN';
    levelCounts[level] = (levelCounts[level] || 0) + 1;
  }
  const lines: string[] = ['', 'Level distribution:'];
  for (const [level, count] of Object.entries(levelCounts).sort()) {
    lines.push(`  ${level}: ${count} athletes`);
  }
  return lines;
}

export const extractionToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {

  mso_extract: async (args) => {
    try {
      const meetIds = requireArray(args, 'meet_ids') as string[];
      if (meetIds.length === 0) {
        return 'Error: meet_ids parameter is required (array of string MSO meet IDs)';
      }

      // Clean up old extract files to prevent data bloat
      const dataDir = getDataDir();
      const prefix = 'mso_extract_';
      if (fs.existsSync(dataDir)) {
        for (const f of fs.readdirSync(dataDir)) {
          if (f.startsWith(prefix) && f.endsWith('.json')) {
            try { fs.unlinkSync(path.join(dataDir, f)); } catch {}
          }
        }
      }
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Direct HTTP API call — no Chrome needed
      const allAthletes: Record<string, unknown>[] = [];
      const counts: Record<string, number> = {};
      const errors: Array<{ meetId: string; error: string }> = [];

      for (const meetId of meetIds) {
        try {
          const resp = await fetch('https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: `p_meetid=${meetId}&query_name=lookup_scores`,
          });
          const data = await resp.json() as { results?: Array<{ result?: { row?: Array<Record<string, string>> } }> };
          const rows = data?.results?.[0]?.result?.row || [];

          if (rows.length === 0) {
            errors.push({ meetId, error: 'No rows returned from API' });
            counts[meetId] = 0;
            continue;
          }

          // Decode HTML entities
          function decodeHtml(html: string): string {
            if (!html) return '';
            return html.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
                       .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
          }

          // Strip MSO event annotations from names
          function cleanName(raw: string): string {
            const decoded = decodeHtml(raw);
            return decoded.replace(/\s*(?:IES\s+)?(?:VT|UB|BB|FX|V|Be|Fl|Fx)(?:[,\s]+(?:VT|UB|BB|FX|V|Be|Fl|Fx))*[,\s]*$/, '').trim();
          }

          const mapped = rows.map(r => ({
            name: cleanName(r.fullname || ''),
            gym: decodeHtml(r.gym || ''),
            session: r.sess || '',
            level: r.level || '',
            division: r.div || '',
            vault: r.EventScore1 || '',
            bars: r.EventScore2 || '',
            beam: r.EventScore3 || '',
            floor: r.EventScore4 || '',
            aa: r.AAScore || '',
            vaultPlace: r.EventPlace1 || '',
            barsPlace: r.EventPlace2 || '',
            beamPlace: r.EventPlace3 || '',
            floorPlace: r.EventPlace4 || '',
            aaPlace: r.AAPlace || '',
            num: r.gymnastnumber || '',
          }));

          allAthletes.push(...mapped);
          counts[meetId] = mapped.length;
        } catch (e) {
          errors.push({ meetId, error: e instanceof Error ? e.message : String(e) });
          counts[meetId] = 0;
        }
      }

      // Save to file
      const filename = `mso_extract_${Date.now()}.json`;
      const filePath = path.join(dataDir, filename);
      fs.writeFileSync(filePath, JSON.stringify(allAthletes, null, 2), 'utf8');

      const parsed = { athletes: allAthletes, counts, errors };

      const fileSize = fs.statSync(filePath).size;
      const sizeKB = (fileSize / 1024).toFixed(1);
      const totalAthletes = parsed.athletes.length;

      // Fetch canonical meet metadata via lookup_meet API
      const meetMeta: Record<string, string> = {};
      for (const meetId of meetIds) {
        try {
          const metaResp = await fetch('https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: `p_meetid=${meetId}&p_eventid=1&query_name=lookup_meet`,
          });
          const metaData = await metaResp.json() as { results?: Array<{ result?: { row?: Array<Record<string, string>> } }> };
          const metaRows = metaData?.results?.[0]?.result?.row || [];
          if (metaRows.length > 0) {
            const m = metaRows[0];
            meetMeta[meetId] = [
              `MSO canonical name: ${m.MeetName || 'unknown'}`,
              `Dates: ${m.meetfulldate_long || 'unknown'}`,
              `Location: ${m.MeetCity || ''}, ${m.MeetState || ''}`,
              `Host: ${m.HostClub || 'unknown'}`,
              `Status: ${m.StatusText || 'unknown'}`,
            ].join('\n    ');
          }
        } catch { /* Non-fatal: skip metadata fetch */ }
      }

      // Build summary with level distribution
      const lines: string[] = [];
      lines.push(`MSO extraction complete. ${totalAthletes} athletes saved to ${filePath} (${sizeKB} KB raw).`);
      lines.push('');
      lines.push('Per-meet counts:');
      for (const [id, count] of Object.entries(parsed.counts)) {
        lines.push(`  meetId ${id}: ${count} athletes`);
        if (meetMeta[id]) {
          lines.push(`    ${meetMeta[id]}`);
        }
      }

      lines.push(...formatLevelDistribution(parsed.athletes));

      if (parsed.errors.length > 0) {
        lines.push('');
        lines.push('Errors:');
        for (const err of parsed.errors) {
          lines.push(`  meetId ${err.meetId}: ${err.error}`);
        }
      }
      lines.push('');
      lines.push(`Next step: build_database with source "generic" and data_path "${filePath}"`);

      return lines.join('\n');
    } catch (err) {
      return `Error in mso_extract: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  scorecat_extract: async (args) => {
    try {
      const meetIds = requireArray(args, 'meet_ids') as string[];
      if (meetIds.length === 0) {
        return 'Error: meet_ids parameter is required (array of string Algolia meet IDs)';
      }

      // Clean up old extract files to prevent data bloat
      const dataDir = getDataDir();
      const prefix = 'scorecat_extract_';
      if (fs.existsSync(dataDir)) {
        for (const f of fs.readdirSync(dataDir)) {
          if (f.startsWith(prefix) && f.endsWith('.json')) {
            try { fs.unlinkSync(path.join(dataDir, f)); } catch {}
          }
        }
      }

      await chromeController.ensureConnected();

      // Navigate to ScoreCat homepage to load Firebase SDK
      await chromeController.navigate('https://results.scorecatonline.com/');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Build the hardcoded extraction script with meetIds interpolated
      const meetIdsJson = JSON.stringify(meetIds);
      const script = `
(async () => {
  // Wait for Firebase SDK to load (up to 15 seconds)
  for (let i = 0; i < 30; i++) {
    if (window.firebase_core && window.firebase_firestore) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!window.firebase_core || !window.firebase_firestore) {
    return JSON.stringify({ athletes: [], counts: {}, errors: [{ meetId: 'all', error: 'Firebase SDK did not load within 15 seconds' }] });
  }

  const fc = window.firebase_core;
  const ff = window.firebase_firestore;
  const app = fc.getApp();
  const db = ff.getFirestore(app);

  const meetIds = ${meetIdsJson};
  const allAthletes = [];
  const counts = {};
  const errors = [];

  for (const meetId of meetIds) {
    try {
      const q = ff.query(
        ff.collection(db, 'ff_scores'),
        ff.where('meetId', '==', meetId)
      );
      const snap = await ff.getDocs(q);

      if (snap.empty) {
        errors.push({ meetId, error: 'No documents found for this meetId' });
        counts[meetId] = 0;
        continue;
      }

      // Strip partial-competitor annotations like "*(V,BB,FX)" or "*(UB)"
      function cleanAnnotation(s) {
        if (!s) return '';
        return s.replace(/\\s*\\*\\s*\\([^)]*\\)\\s*$/, '').trim();
      }

      const mapped = snap.docs.map(d => {
        const data = d.data();
        return {
          firstName: cleanAnnotation(data.firstName || ''),
          lastName: cleanAnnotation(data.lastName || ''),
          clubName: data.clubName || '',
          level: data.level || '',
          division: data.division || '',
          session: data.description || '',
          vault: data.event1Score || '',
          bars: data.event2Score || '',
          beam: data.event3Score || '',
          floor: data.event4Score || '',
          aa: data.event7Score || '',
          vaultPlace: data.event1Place || '',
          barsPlace: data.event2Place || '',
          beamPlace: data.event3Place || '',
          floorPlace: data.event4Place || '',
          aaPlace: data.event7Place || '',
          vaultRank: data.event1Rank || '',
          barsRank: data.event2Rank || '',
          beamRank: data.event3Rank || '',
          floorRank: data.event4Rank || '',
          aaRank: data.event7Rank || ''
        };
      });

      allAthletes.push(...mapped);
      counts[meetId] = mapped.length;
    } catch (e) {
      errors.push({ meetId, error: e.message || String(e) });
      counts[meetId] = 0;
    }
  }

  return JSON.stringify({ athletes: allAthletes, counts, errors });
})()
`;

      const filename = `scorecat_extract_${Date.now()}.json`;
      const filePath = path.join(dataDir, filename);

      const { size } = await chromeController.saveJSToFile(script, filePath, 120000);

      // Read back the wrapper and overwrite with just the athletes array
      const raw = fs.readFileSync(filePath, 'utf8');
      let parsed: { athletes: unknown[]; counts: Record<string, number>; errors: Array<{ meetId: string; error: string }> };
      try {
        const first = JSON.parse(raw);
        if (typeof first === 'string') {
          parsed = JSON.parse(first);
        } else {
          parsed = first;
        }
      } catch (parseErr) {
        return `Error parsing extraction result: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}. Raw file saved at ${filePath}`;
      }

      // Overwrite file with just the athletes array
      fs.writeFileSync(filePath, JSON.stringify(parsed.athletes, null, 2), 'utf8');

      const sizeKB = (size / 1024).toFixed(1);
      const totalAthletes = parsed.athletes.length;

      // Build summary with level distribution
      const lines: string[] = [];
      lines.push(`ScoreCat extraction complete. ${totalAthletes} athletes saved to ${filePath} (${sizeKB} KB raw).`);
      lines.push('');
      lines.push('Per-meet counts:');
      for (const [id, count] of Object.entries(parsed.counts)) {
        lines.push(`  meetId ${id}: ${count} athletes`);
      }

      lines.push(...formatLevelDistribution(parsed.athletes));

      if (parsed.errors.length > 0) {
        lines.push('');
        lines.push('Errors:');
        for (const err of parsed.errors) {
          lines.push(`  meetId ${err.meetId}: ${err.error}`);
        }
      }
      lines.push('');
      lines.push(`Next step: build_database with source "scorecat" and data_path "${filePath}"`);

      return lines.join('\n');
    } catch (err) {
      return `Error in scorecat_extract: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
