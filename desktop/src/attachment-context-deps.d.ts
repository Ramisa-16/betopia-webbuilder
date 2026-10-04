declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export const GlobalWorkerOptions: {
    workerSrc?: string
  }

  export function getDocument(
    options: unknown,
  ): {
    promise: Promise<{
      numPages: number
      getPage: (pageNumber: number) => Promise<{
        getTextContent: () => Promise<{
          items: Array<{ str?: string }>
        }>
      }>
    }>
  }
}

declare module 'mammoth' {
  export function extractRawText(input: {
    arrayBuffer: ArrayBuffer
  }): Promise<{
    value: string
  }>
}

declare module 'jszip' {
  type ZipEntry = {
    async: (type: string) => Promise<string>
  }

  export default class JSZip {
    static loadAsync(data: Uint8Array): Promise<{
      files: Record<string, unknown>
      file: (path: string) => ZipEntry | null
    }>
  }
}
