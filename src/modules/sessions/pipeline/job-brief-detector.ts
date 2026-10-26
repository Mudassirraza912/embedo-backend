/**
 * EAR-11: Upwork & Third-Party Engineering Job Description Detector & Classifier
 */

export interface JobBriefClassification {
  isJobDescription: boolean;
  intentType: 'analyze' | 'generate' | 'client_questions';
  marketplace?: 'upwork' | 'freelancer' | 'rfp' | 'generic';
  detectedMarkers: string[];
}

const UPWORK_MARKERS = [
  'upwork',
  'hourly range',
  'hourly:',
  'fixed-price',
  'est. budget',
  'job description',
  'looking for an experienced',
  'looking for a skilled',
  'we are looking for',
  'we need an embedded',
  'we need a hardware',
  'proposals:',
  'connects to apply',
  'client country',
  'skills and expertise',
  'about the client',
  'deliverables:',
  'project scope:',
];

/**
 * Detects whether pasted text represents a client job posting / RFP.
 */
export function classifyJobBrief(text: string): JobBriefClassification {
  if (!text || text.trim().length < 50) {
    return { isJobDescription: false, intentType: 'generate', detectedMarkers: [] };
  }

  const lower = text.toLowerCase();
  const detectedMarkers = UPWORK_MARKERS.filter((marker) => lower.includes(marker));

  const isJobDescription = detectedMarkers.length >= 2 || (detectedMarkers.length >= 1 && text.length > 300);

  if (!isJobDescription) {
    return { isJobDescription: false, intentType: 'generate', detectedMarkers: [] };
  }

  // Determine user intent:
  // Did the user explicitly ask to generate/create/build an architecture?
  const generateCommands = [
    'generate architecture',
    'create architecture',
    'build this',
    'design this',
    'start design',
    'make the diagram',
    'synthesize architecture',
  ];
  const hasGenerateCommand = generateCommands.some((cmd) => lower.includes(cmd));

  // Did the user ask for client questions?
  const questionsCommands = [
    'client questions',
    'questions for client',
    'what should i ask',
    'interview questions',
  ];
  const hasQuestionsCommand = questionsCommands.some((cmd) => lower.includes(cmd));

  let intentType: JobBriefClassification['intentType'] = 'analyze';
  if (hasGenerateCommand) {
    intentType = 'generate';
  } else if (hasQuestionsCommand) {
    intentType = 'client_questions';
  } else {
    intentType = 'analyze';
  }

  return {
    isJobDescription: true,
    intentType,
    marketplace: lower.includes('upwork') || lower.includes('hourly range') || lower.includes('connects') ? 'upwork' : 'generic',
    detectedMarkers,
  };
}
