import { getRepos } from '../repositories';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

export async function allocateApplicationCode(): Promise<string> {
  const repos = getRepos();
  const existing = await repos.consultantApplications.listAllCodes();
  const consultantCodes = (await repos.consultants.findAll())
    .map((item) => item.consultantCode)
    .filter(Boolean) as string[];
  const used = new Set([...existing, ...consultantCodes]);
  const prefix = `C-${todayKey()}-`;
  let seq = 1;
  while (seq < 1000) {
    const code = `${prefix}${String(seq).padStart(2, '0')}`;
    if (!used.has(code)) {
      return code;
    }
    seq += 1;
  }
  return `C-${todayKey()}-${Date.now().toString().slice(-4)}`;
}
