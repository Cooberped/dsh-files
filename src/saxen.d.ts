declare module 'saxen' {
  export class Parser {
    constructor(options?: { proxy?: boolean })
    ns(mapping?: Record<string, string>): this
    on(name: string, callback: (...args: any[]) => void): this
    parse(xml: string): Error | null
  }
}
