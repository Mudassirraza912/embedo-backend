/**
 * A session is either an Architect project (custom hardware architecture: block diagram, power tree,
 * protocol map, BOM) or a Prototype project (a bench build from existing modules: module diagram,
 * detailed pin list, and the hardware library records of the boards used).
 *
 * The type is chosen with `type` on the chat endpoints and persisted in
 * design_sessions.application_context, which the frontend already writes and reads as
 * "rapid_prototyping" for Prototype mode.
 */
export const SESSION_TYPES = ['architect', 'prototype'] as const;
export type SessionType = (typeof SESSION_TYPES)[number];

export const PROTOTYPE_APPLICATION_CONTEXT = 'rapid_prototyping';
export const ARCHITECT_APPLICATION_CONTEXT = 'hardware_synthesis';

export const sessionTypeOf = (applicationContext: string | null | undefined): SessionType =>
  applicationContext === PROTOTYPE_APPLICATION_CONTEXT ? 'prototype' : 'architect';

/**
 * The application_context to store for a new session. An explicit `type` wins; without one the
 * client's own applicationContext is kept as before. A free-form context that happens to say
 * "rapid_prototyping" under type=architect is replaced so the two can never disagree.
 */
export const applicationContextFor = (type: SessionType | undefined, applicationContext: string | undefined): string | null => {
  if (type === 'prototype') return PROTOTYPE_APPLICATION_CONTEXT;
  if (type === 'architect') {
    return applicationContext && applicationContext !== PROTOTYPE_APPLICATION_CONTEXT ? applicationContext : ARCHITECT_APPLICATION_CONTEXT;
  }
  return applicationContext ?? null;
};
