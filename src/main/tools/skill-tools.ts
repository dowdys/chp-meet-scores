import * as fs from 'fs';
import * as path from 'path';

function getSkillsDir(): string {
  const isDev = !require('electron').app.isPackaged;
  if (isDev) {
    return path.join(__dirname, '..', '..', 'skills');
  }
  return path.join(process.resourcesPath!, 'skills');
}

function getDataDir(): string {
  const isDev = !require('electron').app.isPackaged;
  if (isDev) {
    return path.join(__dirname, '..', '..', 'data');
  }
  return path.join(require('electron').app.getPath('userData'), 'data');
}

function listSkillFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace(/\.md$/, ''));
}

export const skillToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  load_skill: async (args) => {
    try {
      const skillName = args.skill_name as string;
      if (!skillName) {
        return 'Error: skill_name parameter is required';
      }

      const skillsDir = getSkillsDir();
      const filepath = path.join(skillsDir, `${skillName}.md`);

      if (!fs.existsSync(filepath)) {
        const available = listSkillFiles(skillsDir);
        if (available.length === 0) {
          return `Skill "${skillName}" not found. No skills are available in ${skillsDir}.`;
        }
        return `Skill "${skillName}" not found. Available skills: ${available.join(', ')}`;
      }

      return fs.readFileSync(filepath, 'utf8');
    } catch (err) {
      return `Error loading skill: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  load_skill_detail: async (args) => {
    try {
      const detailName = args.detail_name as string;
      if (!detailName) {
        return 'Error: detail_name parameter is required';
      }

      const skillsDir = getSkillsDir();
      const filepath = path.join(skillsDir, 'details', `${detailName}.md`);

      if (!fs.existsSync(filepath)) {
        const detailsDir = path.join(skillsDir, 'details');
        const available = listSkillFiles(detailsDir);
        if (available.length === 0) {
          return `Detail "${detailName}" not found. No detail files are available.`;
        }
        return `Detail "${detailName}" not found. Available details: ${available.join(', ')}`;
      }

      return fs.readFileSync(filepath, 'utf8');
    } catch (err) {
      return `Error loading skill detail: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  save_draft_skill: async (args) => {
    try {
      const platformName = args.platform_name as string;
      const content = args.content as string;
      if (!platformName || !content) {
        return 'Error: platform_name and content parameters are required';
      }

      const skillsDir = getSkillsDir();
      const draftsDir = path.join(skillsDir, 'drafts');
      if (!fs.existsSync(draftsDir)) {
        fs.mkdirSync(draftsDir, { recursive: true });
      }

      const header = `# Draft Skill: ${platformName}\n\n> Agent-written draft - needs developer review\n> Generated: ${new Date().toISOString()}\n\n`;
      const fullContent = header + content;

      const filepath = path.join(draftsDir, `${platformName}.md`);
      fs.writeFileSync(filepath, fullContent, 'utf8');

      return `Draft skill saved to ${filepath}`;
    } catch (err) {
      return `Error saving draft skill: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  list_skills: async () => {
    try {
      const skillsDir = getSkillsDir();
      if (!fs.existsSync(skillsDir)) {
        return `No skills directory found at ${skillsDir}.`;
      }

      // List top-level .md files only (exclude details/ and drafts/ subdirectories)
      const files = fs.readdirSync(skillsDir)
        .filter(f => f.endsWith('.md') && fs.statSync(path.join(skillsDir, f)).isFile());

      if (files.length === 0) {
        return 'No skills available.';
      }

      const names = files.map(f => f.replace(/\.md$/, ''));
      return `Available skills: ${names.join(', ')}`;
    } catch (err) {
      return `Error listing skills: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  save_progress: async (args) => {
    try {
      const summary = args.summary as string;
      const nextSteps = args.next_steps as string[];
      if (!summary) {
        return 'Error: summary parameter is required';
      }

      const dataDir = getDataDir();
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const progress = {
        summary,
        next_steps: nextSteps || [],
        timestamp: new Date().toISOString(),
      };

      const filepath = path.join(dataDir, 'agent_progress.json');
      fs.writeFileSync(filepath, JSON.stringify(progress, null, 2), 'utf8');

      return `Progress saved to ${filepath}`;
    } catch (err) {
      return `Error saving progress: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  load_progress: async () => {
    try {
      const dataDir = getDataDir();
      const filepath = path.join(dataDir, 'agent_progress.json');

      if (!fs.existsSync(filepath)) {
        return 'No saved progress found.';
      }

      const content = fs.readFileSync(filepath, 'utf8');
      return content;
    } catch (err) {
      return `Error loading progress: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  list_output_files: async (args) => {
    try {
      const meetSlug = args.meet_slug as string;
      if (!meetSlug) {
        return 'Error: meet_slug parameter is required';
      }

      const dataDir = getDataDir();
      const outputDir = path.join(dataDir, 'outputs', meetSlug);

      if (!fs.existsSync(outputDir)) {
        return `No output directory found for "${meetSlug}" at ${outputDir}.`;
      }

      const files = fs.readdirSync(outputDir);
      if (files.length === 0) {
        return `Output directory for "${meetSlug}" is empty.`;
      }

      const fileList = files.map(f => {
        const filepath = path.join(outputDir, f);
        const stats = fs.statSync(filepath);
        const sizeKb = (stats.size / 1024).toFixed(1);
        return `  ${f} (${sizeKb} KB)`;
      });

      return `Files in ${outputDir}:\n${fileList.join('\n')}`;
    } catch (err) {
      return `Error listing output files: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
