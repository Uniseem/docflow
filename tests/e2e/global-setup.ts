import { listenMockProvider, DEFAULT_MOCK_PORT } from '../mock-provider/server'

export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await listenMockProvider(DEFAULT_MOCK_PORT)
  return async () => {
    await server.close()
  }
}
