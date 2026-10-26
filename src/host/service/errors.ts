import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Stable Univer domain error retained by DSH tool results and replay. */
export class UniverError extends HarnessError {
  /** Create a classified Univer error. */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
  }
}
