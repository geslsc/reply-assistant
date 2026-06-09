import { getRepos } from '../repositories';

/** 分配 G-01 / G-02 / G-03 格式的群組代號 */
export async function allocateGroupCode(): Promise<string> {
  const existing = await getRepos().groupConsultantAssignments.listAllGroupCodes();
  const used = new Set(existing);
  let seq = 1;
  while (seq < 10000) {
    const code = `G-${String(seq).padStart(2, '0')}`;
    if (!used.has(code)) {
      return code;
    }
    seq += 1;
  }
  return `G-${Date.now().toString().slice(-4)}`;
}
