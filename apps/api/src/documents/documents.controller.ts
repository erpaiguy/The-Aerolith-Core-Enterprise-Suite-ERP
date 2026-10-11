import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { TenantClaims } from '../auth/auth.service.js';
import { Auth, RequiresFeatures, Roles, TenantAuthGuard } from '../auth/guards.js';
import { PermissionGuard, RequiresPermission } from '../auth/permissions.js';
import { attachment } from '../boq/import/import.controller.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { TRASH_DAYS } from './document-settings.js';
import { DocumentsService, projectVault, tenderVault, type Vault } from './documents.service.js';
import { DocumentLifecycle } from './lifecycle.service.js';

const rowVersion = z.number().int().positive();
const folderCreate = z.object({
  parentId: z.uuid().nullable().default(null),
  name: z.string().max(200),
  restricted: z.boolean().default(false),
});
const folderUpdate = z.object({
  rowVersion,
  name: z.string().max(200).optional(),
  restricted: z.boolean().optional(),
  /** Moves the folder under another one of the tender; null: to the top level. */
  parentId: z.uuid().nullable().optional(),
});
const uploadQuery = z.object({
  folderId: z.uuid().optional(),
  /** Sub-folders of an uploaded folder, e.g. "Drawings/Structural". */
  path: z.string().max(1000).optional(),
  note: z.string().max(1000).optional(),
  /** Upload as a new version of this document, whatever the file is called. */
  documentId: z.uuid().optional(),
});
const documentUpdate = z.object({
  rowVersion,
  name: z.string().max(300).optional(),
  description: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().max(100)).max(40).optional(),
  folderId: z.uuid().nullable().optional(),
});
const fileQuery = z.object({ version: z.coerce.number().int().positive().optional() });
const zipBody = z.object({
  folderId: z.uuid().nullable().default(null),
  documentIds: z.array(z.uuid()).max(2000).nullable().default(null),
});
const searchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(100).optional(),
  tenderId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type Claims = TenantClaims;

/** Files are always downloads, never pages: the browser must not render or sniff them on our origin. */
function fileHeaders(reply: FastifyReply) {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
  reply.header('Cache-Control', 'private, no-store');
}

const foldersBody = z.object({
  folders: z
    .array(z.object({ path: z.string().max(1000), restricted: z.boolean().default(false) }))
    .max(200)
    .nullable(),
});
const trashBody = z.object({
  days: z
    .number()
    .int()
    .refine((d) => (TRASH_DAYS as readonly number[]).includes(d), 'One of 30, 90, 180, 365')
    .nullable(),
});

const linkBody = z.object({
  kind: z.enum(['rfq_vendor', 'checklist_item', 'addendum', 'goods_receipt']),
  targetId: z.string().min(1).max(80),
});

/**
 * Tender documents (docs/wave1-plan.md step 10). Everyone reads (restricted folders need `pricing.edit`); changes
 * need `documents.edit`.
 */
@Controller('tenant')
@UseGuards(TenantAuthGuard, PermissionGuard)
export class DocumentsController {
  constructor(
    private readonly docs: DocumentsService,
    private readonly lifecycle: DocumentLifecycle,
  ) {}

  @Get('tenders/:id/documents')
  vault(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.vault(c, tenderVault(id));
  }

  @Get('tenders/:id/documents/trash')
  trash(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.trash(c, tenderVault(id));
  }

  // A project's vault (docs/wave2b-plan.md step 8): the same as a tender's, kept to the project's team.

  @Get('projects/:id/documents')
  projectVault(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.vault(c, projectVault(id));
  }

  @Get('projects/:id/documents/trash')
  projectTrash(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.trash(c, projectVault(id));
  }

  @Post('projects/:id/folders')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  createProjectFolder(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(folderCreate)) b: z.infer<typeof folderCreate>,
  ) {
    return this.docs.createFolder(c, projectVault(id), b);
  }

  @Post('projects/:id/folders/standard')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  projectStandardFolders(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.standardFolders(c, projectVault(id));
  }

  /** multipart/form-data, field `file`, as for a tender. */
  @Post('projects/:id/documents/upload')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  projectUpload(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(uploadQuery)) q: z.infer<typeof uploadQuery>,
    @Req() req: FastifyRequest,
  ) {
    return this.receive(c, projectVault(id), q, req);
  }

  @Post('projects/:id/documents/zip')
  @HttpCode(200)
  async projectZip(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(zipBody)) b: z.infer<typeof zipBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const z = await this.docs.zip(c, projectVault(id), b);
    fileHeaders(reply);
    return new StreamableFile(z.stream, {
      type: 'application/zip',
      disposition: attachment(z.fileName),
    });
  }

  @Post('projects/:id/documents/trash/empty')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  emptyProjectTrash(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.lifecycle.emptyTrash(c, projectVault(id));
  }

  @Post('tenders/:id/folders')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  createFolder(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(folderCreate)) b: z.infer<typeof folderCreate>,
  ) {
    return this.docs.createFolder(c, tenderVault(id), b);
  }

  @Post('tenders/:id/folders/standard')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  standardFolders(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.standardFolders(c, tenderVault(id));
  }

  @Post('folders/:id')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  updateFolder(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(folderUpdate)) b: z.infer<typeof folderUpdate>,
  ) {
    return this.docs.updateFolder(c, id, b);
  }

  @Post('folders/:id/delete')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  deleteFolder(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.deleteFolder(c, id);
  }

  /** multipart/form-data, field `file`: one file per request (the app sends several at a time). */
  @Post('tenders/:id/documents/upload')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  upload(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(uploadQuery)) q: z.infer<typeof uploadQuery>,
    @Req() req: FastifyRequest,
  ) {
    return this.receive(c, tenderVault(id), q, req);
  }

  private async receive(
    c: Claims,
    vault: Vault,
    q: z.infer<typeof uploadQuery>,
    req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the file as form data.',
      });
    // One byte over the limit, so a file exactly at the limit is accepted and one over it is caught.
    const file = await req.file({
      limits: { fileSize: this.docs.maxBytes + 1, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No file was sent.' });
    return this.docs.upload(
      c,
      vault,
      {
        folderId: q.folderId ?? null,
        path: q.path ?? null,
        note: q.note?.trim() ?? '',
        documentId: q.documentId ?? null,
      },
      { name: file.filename, stream: file.file, truncated: () => file.file.truncated },
    );
  }

  @Get('documents')
  search(@Auth() c: Claims, @Query(new ZodPipe(searchQuery)) q: z.infer<typeof searchQuery>) {
    return this.docs.search(c, {
      q: q.q || null,
      tag: q.tag || null,
      tenderId: q.tenderId ?? null,
      projectId: q.projectId ?? null,
      limit: q.limit,
    });
  }

  @Get('document-tags')
  tags(@Auth() c: Claims) {
    return this.docs.tags(c);
  }

  @Get('documents/:id')
  get(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.get(c, id);
  }

  @Post('documents/:id')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  update(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(documentUpdate)) b: z.infer<typeof documentUpdate>,
  ) {
    return this.docs.update(c, id, b);
  }

  @Post('documents/:id/delete')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  remove(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.remove(c, id);
  }

  /** Links the document to a vendor's quote on an RFQ, a checklist item or an addendum of its tender. */
  @Post('documents/:id/links')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  link(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(linkBody)) b: z.infer<typeof linkBody>,
  ) {
    return this.docs.link(c, id, b.kind, b.targetId);
  }

  @Post('documents/:id/links/delete')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  unlink(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(linkBody)) b: z.infer<typeof linkBody>,
  ) {
    return this.docs.unlink(c, id, b.kind, b.targetId);
  }

  /** The admin deletes a document in the trash for good. */
  @Post('documents/:id/purge')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  purge(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.lifecycle.purge(c, id);
  }

  @Post('tenders/:id/documents/trash/empty')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  emptyTrash(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.lifecycle.emptyTrash(c, tenderVault(id));
  }

  /** The company's standard folders and how long the trash keeps documents (docs/wave1-plan.md step 13). */
  @Get('document-settings')
  settings(@Auth() c: Claims) {
    return this.lifecycle.settings(c);
  }

  @Post('document-settings/folders')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  setFolders(@Auth() c: Claims, @Body(new ZodPipe(foldersBody)) b: z.infer<typeof foldersBody>) {
    return this.lifecycle.setFolders(c, b.folders);
  }

  @Post('document-settings/trash')
  @HttpCode(200)
  @Roles('admin')
  @RequiresFeatures()
  setTrash(@Auth() c: Claims, @Body(new ZodPipe(trashBody)) b: z.infer<typeof trashBody>) {
    return this.lifecycle.setTrashDays(c, b.days);
  }

  @Post('documents/:id/restore')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  restore(@Auth() c: Claims, @Param('id', ParseUUIDPipe) id: string) {
    return this.docs.restore(c, id);
  }

  /** The bytes of a version (latest by default). Reading, so allowed on a read-only licence too. */
  @Get('documents/:id/file')
  async file(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(fileQuery)) q: z.infer<typeof fileQuery>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const f = await this.docs.file(c, id, q.version ?? null);
    fileHeaders(reply);
    return new StreamableFile(f.stream, {
      type: f.mime,
      length: f.size,
      disposition: attachment(f.fileName),
    });
  }

  /** The latest version's thumbnail (a small picture made by a browser), or 404. */
  @Get('documents/:id/thumbnail')
  async thumbnail(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const t = await this.docs.thumbnail(c, id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'");
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Version', String(t.versionNo));
    return new StreamableFile(t.bytes, { type: t.mime, length: t.bytes.length });
  }

  /** multipart/form-data, field `file`: the thumbnail of a version, made by the browser that has the file. */
  @Post('documents/:id/versions/:version/thumbnail')
  @HttpCode(200)
  @RequiresPermission('documents.edit')
  @RequiresFeatures()
  async saveThumbnail(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('version', new ZodPipe(z.coerce.number().int().positive())) version: number,
    @Req() req: FastifyRequest,
  ) {
    if (!req.isMultipart())
      throw new BadRequestException({
        code: 'not_multipart',
        message: 'Send the picture as form data.',
      });
    const file = await req.file({
      limits: { fileSize: 200 * 1024 + 1, files: 1, fields: 0, parts: 1 },
    });
    if (!file) throw new BadRequestException({ code: 'no_file', message: 'No picture was sent.' });
    const bytes = await file.toBuffer().catch(() => null);
    if (!bytes || file.file.truncated)
      throw new BadRequestException({
        code: 'bad_thumbnail',
        message: 'A thumbnail is at most 200 KB.',
      });
    return this.docs.saveThumbnail(c, id, version, bytes);
  }

  /** A ZIP of a folder, chosen documents, or the whole vault (latest versions). */
  @Post('tenders/:id/documents/zip')
  @HttpCode(200)
  async zip(
    @Auth() c: Claims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(zipBody)) b: z.infer<typeof zipBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const z = await this.docs.zip(c, tenderVault(id), b);
    fileHeaders(reply);
    return new StreamableFile(z.stream, {
      type: 'application/zip',
      disposition: attachment(z.fileName),
    });
  }
}
