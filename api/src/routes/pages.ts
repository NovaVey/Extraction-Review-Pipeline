import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pages } from '../db/schema.js';
import { downloadObject } from '../lib/storage.js';

export async function pageRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/pages/:id/image', async (req, reply) => {
    const { id } = req.params;
    const [page] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
    if (!page) {
      return reply.code(404).send({ error: 'page_not_found' });
    }

    // pageRender.ts always rasterizes to PNG (canvas.toBuffer('image/png')), so the
    // content-type here isn't derived from anything stored per-page.
    const image = await downloadObject(page.imagePath);
    reply.type('image/png').send(image);
  });
}
