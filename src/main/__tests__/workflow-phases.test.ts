import { describe, it, expect } from 'vitest';
import {
  getAllPhases,
  getToolsForPhase,
  filterToolsForPhase,
  getToolHomePhase,
  getPhaseDefinition,
  WorkflowPhase,
} from '../workflow-phases';

const ALWAYS_AVAILABLE = [
  'set_phase', 'unlock_tool', 'ask_user', 'read_file',
  'run_script', 'save_progress', 'load_progress',
  'list_skills', 'load_skill',
];

describe('workflow-phases', () => {
  describe('getAllPhases', () => {
    it('returns all 5 phases', () => {
      const phases = getAllPhases();
      expect(phases).toEqual(['discovery', 'extraction', 'database', 'output_finalize', 'import_backs']);
    });
  });

  describe('getToolsForPhase', () => {
    it('always includes always-available tools', () => {
      for (const phase of getAllPhases()) {
        const tools = getToolsForPhase(phase);
        for (const tool of ALWAYS_AVAILABLE) {
          expect(tools).toContain(tool);
        }
      }
    });

    it('discovery phase has search tools but not build_database', () => {
      const tools = getToolsForPhase('discovery');
      expect(tools).toContain('search_meets');
      expect(tools).toContain('lookup_meet');
      expect(tools).toContain('set_output_name');
      expect(tools).toContain('web_search');
      expect(tools).not.toContain('build_database');
      expect(tools).not.toContain('mso_extract');
      expect(tools).not.toContain('finalize_meet');
    });

    it('extraction phase has extraction tools but not build_database', () => {
      const tools = getToolsForPhase('extraction');
      expect(tools).toContain('mso_extract');
      expect(tools).toContain('scorecat_extract');
      expect(tools).not.toContain('build_database');
      expect(tools).not.toContain('search_meets');
      expect(tools).not.toContain('finalize_meet');
      // Chrome tools removed from extraction — available via unlock_tool only
      expect(tools).not.toContain('chrome_navigate');
      expect(tools).not.toContain('chrome_execute_js');
      expect(tools).not.toContain('chrome_screenshot');
    });

    it('database phase has build_database but not extraction or output tools', () => {
      const tools = getToolsForPhase('database');
      expect(tools).toContain('build_database');
      expect(tools).toContain('query_db');
      expect(tools).toContain('get_meet_summary');
      expect(tools).not.toContain('mso_extract');
      expect(tools).not.toContain('scorecat_extract');
      expect(tools).not.toContain('regenerate_output');
      expect(tools).not.toContain('finalize_meet');
    });

    it('output_finalize phase has output and finalize tools but not extraction', () => {
      const tools = getToolsForPhase('output_finalize');
      expect(tools).toContain('regenerate_output');
      expect(tools).toContain('finalize_meet');
      expect(tools).toContain('render_pdf_page');
      expect(tools).toContain('open_file');
      expect(tools).toContain('query_db');
      expect(tools).not.toContain('mso_extract');
      expect(tools).not.toContain('build_database');
      expect(tools).not.toContain('search_meets');
    });

    it('import_backs phase has import_pdf_backs and regenerate_output but not build_database or extraction', () => {
      const tools = getToolsForPhase('import_backs');
      expect(tools).toContain('import_pdf_backs');
      expect(tools).toContain('list_meets');
      expect(tools).toContain('open_file');
      expect(tools).toContain('regenerate_output');
      expect(tools).not.toContain('build_database');
      expect(tools).not.toContain('mso_extract');
      expect(tools).not.toContain('finalize_meet');
    });

    it('respects unlocked tools', () => {
      const tools = getToolsForPhase('discovery', ['build_database']);
      expect(tools).toContain('build_database');
      expect(tools).toContain('search_meets');
    });
  });

  describe('filterToolsForPhase', () => {
    it('filters a tool definition array to only phase-available tools', () => {
      const mockTools = [
        { name: 'search_meets', description: '', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'build_database', description: '', input_schema: { type: 'object' as const, properties: {} } },
        { name: 'ask_user', description: '', input_schema: { type: 'object' as const, properties: {} } },
      ];
      const filtered = filterToolsForPhase(mockTools, 'discovery');
      const names = filtered.map(t => t.name);
      expect(names).toContain('search_meets');
      expect(names).toContain('ask_user');
      expect(names).not.toContain('build_database');
    });
  });

  describe('getToolHomePhase', () => {
    it('returns null for always-available tools', () => {
      expect(getToolHomePhase('ask_user')).toBeNull();
      expect(getToolHomePhase('set_phase')).toBeNull();
      expect(getToolHomePhase('run_script')).toBeNull();
    });

    it('returns the correct phase for phase-specific tools', () => {
      expect(getToolHomePhase('search_meets')).toBe('discovery');
      expect(getToolHomePhase('mso_extract')).toBe('extraction');
      expect(getToolHomePhase('build_database')).toBe('database');
      // regenerate_output is in multiple phases — getToolHomePhase returns the first one found
      const regenPhase = getToolHomePhase('regenerate_output');
      expect(['output_finalize', 'import_backs']).toContain(regenPhase);
      expect(getToolHomePhase('import_pdf_backs')).toBe('import_backs');
    });

    it('returns undefined for nonexistent tools', () => {
      expect(getToolHomePhase('nonexistent_tool')).toBeUndefined();
    });
  });

  describe('getPhaseDefinition', () => {
    it('returns valid definitions for all phases', () => {
      for (const phase of getAllPhases()) {
        const def = getPhaseDefinition(phase);
        expect(def.name).toBe(phase);
        expect(def.description).toBeTruthy();
        expect(def.tools.length).toBeGreaterThan(0);
        expect(def.prompt).toBeTruthy();
      }
    });
  });

  describe('no tool appears in multiple phases', () => {
    it('each phase-specific tool belongs to exactly one phase', () => {
      const toolPhaseMap = new Map<string, WorkflowPhase[]>();
      for (const phase of getAllPhases()) {
        const def = getPhaseDefinition(phase);
        for (const tool of def.tools) {
          if (!toolPhaseMap.has(tool)) toolPhaseMap.set(tool, []);
          toolPhaseMap.get(tool)!.push(phase);
        }
      }

      // Tools that legitimately appear in multiple phases
      const SHARED_TOOLS = new Set([
        'chrome_navigate', 'chrome_execute_js', 'chrome_screenshot', 'chrome_click',
        'chrome_save_to_file', 'http_fetch', 'save_to_file',
        'query_db', 'query_db_to_file', 'list_output_files', 'list_meets',
        'get_meet_summary', 'set_output_name',
        'open_file', 'render_pdf_page',
        'regenerate_output', 'rename_gym', 'fix_names', 'pull_meet', 'finalize_meet',
      ]);

      for (const [tool, phases] of toolPhaseMap) {
        if (SHARED_TOOLS.has(tool)) continue;
        expect(phases.length).toBe(1);
      }
    });
  });
});
