import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { hardwareAdminService } from '../../src/modules/hardware/hardware-admin.service.js';
import { hardwareProposalService } from '../../src/modules/hardware/hardware-proposal.service.js';
import { FIXTURE_IDS, fixtureUpload } from './prototype-fixtures.js';

/** Scraped hardware must wait for an admin; approval is the only path into the library. */
describe('hardware review queue (scraped hardware needs admin acceptance)', () => {
  afterEach(() => jest.restoreAllMocks());
  const admin = { userId: 'a1', label: 'admin@embedo.ai' };

  it('queues a new scraped board as pending without touching the library', async () => {
    jest.spyOn(prisma.hardwareChangeProposal, 'findFirst').mockResolvedValue(null);
    jest.spyOn(prisma.hardwareEntity, 'findUnique').mockResolvedValue(null);
    const create = jest.spyOn(prisma.hardwareChangeProposal, 'create').mockImplementation(((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ proposalId: 'p1', ...args.data })) as never);
    const save = jest.spyOn(hardwareAdminService, 'save');

    const result = await hardwareProposalService.submitProposal(fixtureUpload(FIXTURE_IDS.gps), {
      sourceType: 'vendor_agent',
      sourceReference: 'https://www.adafruit.com/product/746',
      proposedBy: 'vendor-agent',
    });

    expect(create.mock.calls[0]![0].data).toMatchObject({ status: 'pending', changeClass: 'new_entity', proposedHardwareEntityId: 'HW-FX04', sourceType: 'vendor_agent' });
    expect(result.duplicate).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('refreshes the open proposal for a board instead of adding a duplicate row', async () => {
    jest.spyOn(prisma.hardwareChangeProposal, 'findFirst')
      .mockResolvedValueOnce(null) // no identical content
      .mockResolvedValueOnce({ proposalId: 'open-1' } as never); // but an open proposal for this board
    jest.spyOn(prisma.hardwareEntity, 'findUnique').mockResolvedValue(null);
    const create = jest.spyOn(prisma.hardwareChangeProposal, 'create');
    const update = jest.spyOn(prisma.hardwareChangeProposal, 'update').mockResolvedValue({ proposalId: 'open-1', status: 'pending' } as never);
    const result = await hardwareProposalService.submitProposal(fixtureUpload(FIXTURE_IDS.gps), { sourceType: 'vendor_agent', proposedBy: 'vendor-agent' });
    expect(create).not.toHaveBeenCalled();
    expect(update.mock.calls[0]![0].where).toEqual({ proposalId: 'open-1' });
    expect(result).toMatchObject({ proposalId: 'open-1', duplicate: true });
  });

  it('classifies a changed pin table as engineering-sensitive and an invalid scrape as needs_review', async () => {
    const upload = fixtureUpload(FIXTURE_IDS.gps);
    const record = upload.record as Record<string, unknown>;
    jest.spyOn(prisma.hardwareChangeProposal, 'findFirst').mockResolvedValue(null);
    jest.spyOn(prisma.hardwareEntity, 'findUnique').mockResolvedValue({
      metadataJson: { ...record, pins: (record['pins'] as unknown[]).slice(1) },
      svgAsset: { svgMarkup: upload.svg },
    } as never);
    const create = jest.spyOn(prisma.hardwareChangeProposal, 'create').mockImplementation(((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ proposalId: 'p2', ...args.data })) as never);
    await hardwareProposalService.submitProposal(upload, { sourceType: 'vendor_agent', proposedBy: 'vendor-agent' });
    expect(create.mock.calls[0]![0].data).toMatchObject({ changeClass: 'engineering_sensitive', diff: { changedBlocks: ['pins'] } });

    jest.spyOn(prisma.hardwareEntity, 'findUnique').mockResolvedValue(null);
    await hardwareProposalService.submitProposal({ ...upload, svg: upload.svg.replace('<svg', '<svg onload="x()"') }, { sourceType: 'vendor_agent', proposedBy: 'vendor-agent' });
    expect(create.mock.calls[1]![0].data).toMatchObject({ status: 'needs_review' });
  });

  it('on approval stores the board as provisional vendor_agent, unless the admin confirms it', async () => {
    const upload = fixtureUpload(FIXTURE_IDS.gps);
    (upload.record as { status_governance: Record<string, unknown> }).status_governance.review_status = 'confirmed'; // a scraper cannot self-certify
    jest.spyOn(prisma.hardwareChangeProposal, 'findUnique').mockResolvedValue({
      proposalId: 'p3',
      status: 'pending',
      sourceType: 'vendor_agent',
      proposedHardwareEntityId: 'HW-FX04',
      candidatePayload: upload,
    } as never);
    jest.spyOn(prisma.hardwareEntity, 'findUnique').mockResolvedValue(null);
    const save = jest
      .spyOn(hardwareAdminService, 'save')
      .mockResolvedValue({ hardwareEntityId: 'HW-FX04', outcome: 'created', embedding: 'embedded', issues: [] });
    const governance = jest.spyOn(hardwareAdminService, 'updateGovernance').mockResolvedValue({} as never);
    const update = jest.spyOn(prisma.hardwareChangeProposal, 'update').mockResolvedValue({ status: 'approved' } as never);
    jest.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as never);

    const result = await hardwareProposalService.approve('p3', { notes: 'checked against the schematic' }, admin);

    const saved = save.mock.calls[0]![0].record as { status_governance: Record<string, unknown> };
    expect(saved.status_governance).toMatchObject({ review_status: 'provisional', record_origin: 'vendor_agent', scope: 'shared_library' });
    expect(save.mock.calls[0]![2]).toBe('create');
    expect(governance).not.toHaveBeenCalled();
    expect(update.mock.calls[0]![0].data).toMatchObject({ status: 'approved', hardwareEntityId: 'HW-FX04', reviewedBy: 'admin@embedo.ai' });
    expect(result.saved.embedding).toBe('embedded');

    await hardwareProposalService.approve('p3', { reviewStatus: 'confirmed', assetReadiness: 'wiring_ready' }, admin);
    expect(governance).toHaveBeenCalledWith('HW-FX04', { reviewStatus: 'confirmed', assetReadiness: 'wiring_ready' }, admin);
  });

  it('cannot approve or reject a proposal twice', async () => {
    jest.spyOn(prisma.hardwareChangeProposal, 'findUnique').mockResolvedValue({ proposalId: 'p4', status: 'rejected' } as never);
    await expect(hardwareProposalService.approve('p4', {}, admin)).rejects.toMatchObject({ statusCode: 409 });
    await expect(hardwareProposalService.reject('p4', 'dup', admin)).rejects.toMatchObject({ statusCode: 409 });
  });
});
