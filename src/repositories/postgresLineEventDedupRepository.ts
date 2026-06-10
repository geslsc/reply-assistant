import { Pool } from 'pg';
import { LineEventDedupRepository } from './interfaces';

export function createPostgresLineEventDedupRepository(pool: Pool): LineEventDedupRepository {
  return {
    async claim(eventId, processedAt) {
      const result = await pool.query(
        `INSERT INTO processed_line_events (event_id, processed_at)
         VALUES ($1, $2)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, processedAt]
      );
      return result.rowCount === 1;
    },
    async clear() {
      await pool.query('DELETE FROM processed_line_events');
    },
  };
}
