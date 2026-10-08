import { describe, expect, it } from '@jest/globals';
import { recoverConversationContext } from '../../src/modules/sessions/pipeline/conversation-context.js';

describe('recoverConversationContext', () => {
  it('drops rejected opening exchanges but preserves the project brief and clarification answers', () => {
    const recovered = recoverConversationContext(
      [
        { role: 'user', content: 'adsdada' },
        { role: 'assistant', content: 'Please rephrase.', metadata: { isGibberish: true, isOffTopic: true } },
        { role: 'user', content: 'how to boil egg' },
        { role: 'assistant', content: 'I focus on embedded hardware.', metadata: { isOffTopic: true } },
        { role: 'user', content: 'water motor controller' },
        { role: 'assistant', content: 'What should it do?', metadata: { clarificationQuestions: ['What should it do?'] } },
        { role: 'user', content: 'Remote mobile control and auto-stop when the tank is full.' },
        { role: 'assistant', content: 'Which sensor should detect the water level?', metadata: { clarificationQuestions: ['Which sensor?'] } },
        { role: 'user', content: 'Use a float switch sensor.' },
      ],
      'adsdada'
    );

    expect(recovered.intentText).toBe('water motor controller');
    expect(recovered.history.map((turn) => turn.content)).toEqual([
      'water motor controller',
      'What should it do?',
      'Remote mobile control and auto-stop when the tank is full.',
      'Which sensor should detect the water level?',
      'Use a float switch sensor.',
    ]);
  });

  it('uses the first valid brief as the stable intent on subsequent pipeline runs', () => {
    const recovered = recoverConversationContext(
      [
        { role: 'user', content: 'adsdada' },
        { role: 'assistant', content: 'Please rephrase.', metadata: { isGibberish: true } },
        { role: 'user', content: 'water motor controller' },
        { role: 'assistant', content: 'How is it powered?', metadata: { clarificationQuestions: ['How is it powered?'] } },
        { role: 'user', content: 'use Float Switch sensor' },
      ],
      'water motor controller'
    );

    expect(recovered.intentText).toBe('water motor controller');
    expect(recovered.history.map((turn) => turn.content)).toContain('use Float Switch sensor');
  });
});
