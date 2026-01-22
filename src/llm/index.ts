import { ConvertedNote, Ink2MDSettings } from '../types';
import { OpenAIVisionProvider } from './openaiProvider';
import { LocalVisionProvider } from './localProvider';

interface VisionProvider {
  generateMarkdown(note: ConvertedNote): Promise<string>;
}

export class LLMService {
  private provider: VisionProvider;

  constructor(settings: Ink2MDSettings) {
    if (settings.llmProvider === 'openai') {
      this.provider = new OpenAIVisionProvider(settings.openAI);
    } else {
      this.provider = new LocalVisionProvider(settings.local);
    }
  }

  generateMarkdown(note: ConvertedNote): Promise<string> {
    return this.provider.generateMarkdown(note);
  }
}
