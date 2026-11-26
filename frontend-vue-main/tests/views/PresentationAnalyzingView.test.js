import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { usePresentationStore } from '../../src/stores/presentationStore.js'
import PresentationAnalyzingView from '../../src/views/presentation/PresentationAnalyzingView.vue'

const createArtifacts = (store) => store.setRecordingArtifacts({
  webmBlob: new Blob(['video'], { type: 'video/webm' }),
  wavBlob: new Blob(['audio'], { type: 'audio/wav' }),
  text: [{ page: 1, timestamp: 0, content: '발표 내용' }],
  nonverbal: { gazeDeviationCount: 0, gazeEvents: [], tiltBuckets: [] },
  durationMs: 12_000,
})

const mountView = async ({ phase = 'complete' } = {}) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/presentation/analyzing', component: PresentationAnalyzingView },
      { path: '/presentation/qna', component: { template: '<div>qna</div>' } },
      { path: '/presentation/report', component: { template: '<div>report</div>' } },
    ],
  })
  await router.push({ path: '/presentation/analyzing', query: { phase } })
  await router.isReady()
  const wrapper = mount(PresentationAnalyzingView, {
    global: { plugins: [router] },
  })
  await flushPromises()
  return { wrapper, router }
}

describe('PresentationAnalyzingView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStorage.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('sends complete from the analyzing screen and opens the report when Q&A is disabled', async () => {
    const store = usePresentationStore()
    store.sessionId = 9
    store.qnaEnabled = false
    createArtifacts(store)
    const complete = vi.spyOn(store, 'completeSession').mockImplementation(async () => {
      store.sessionStatus = 'completed'
    })
    const loadReport = vi.spyOn(store, 'loadReport').mockResolvedValue({
      score: { overallScore: 91 },
    })
    vi.spyOn(store, 'loadReportJobStatus').mockResolvedValue({ status: 'COMPLETED' })

    const { wrapper, router } = await mountView()

    expect(complete).toHaveBeenCalledWith({ durationMs: 12_000 })
    expect(loadReport).toHaveBeenCalledWith(9)
    expect(router.currentRoute.value.path).toBe('/presentation/report')
    wrapper.unmount()
  })

  test('generates Q&A before complete and waits to complete until Q&A ends', async () => {
    const store = usePresentationStore()
    store.sessionId = 9
    store.qnaEnabled = true
    createArtifacts(store)
    const complete = vi.spyOn(store, 'completeSession')
    const generateQuestions = vi.spyOn(store, 'generateAudienceQuestions').mockResolvedValue([
      { id: 201, content: '질문' },
    ])
    const loadReport = vi.spyOn(store, 'loadReport').mockResolvedValue({})

    const { wrapper, router } = await mountView()

    expect(complete).not.toHaveBeenCalled()
    expect(generateQuestions).toHaveBeenCalledOnce()
    expect(loadReport).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/presentation/qna')
    wrapper.unmount()
  })

  test('completes exactly once after Q&A final end and then polls the report', async () => {
    const store = usePresentationStore()
    store.sessionId = 9
    store.qnaEnabled = true
    createArtifacts(store)
    const complete = vi.spyOn(store, 'completeSession').mockImplementation(async () => {
      store.sessionStatus = 'completed'
    })
    const generateQuestions = vi.spyOn(store, 'generateAudienceQuestions')
    const loadReport = vi.spyOn(store, 'loadReport').mockResolvedValue({
      score: { overallScore: 91 },
    })
    vi.spyOn(store, 'loadReportJobStatus').mockResolvedValue({ status: 'COMPLETED' })

    const { wrapper, router } = await mountView({ phase: 'report' })

    expect(complete).toHaveBeenCalledOnce()
    expect(generateQuestions).not.toHaveBeenCalled()
    expect(loadReport).toHaveBeenCalledWith(9)
    expect(router.currentRoute.value.path).toBe('/presentation/report')
    wrapper.unmount()
  })

  test('polls the Spring report job status and fetches the report only after COMPLETED', async () => {
    const store = usePresentationStore()
    store.sessionId = 9
    store.sessionStatus = 'completed'
    const loadStatus = vi.spyOn(store, 'loadReportJobStatus')
      .mockResolvedValueOnce({ status: 'STT_ANALYZING' })
      .mockResolvedValueOnce({ status: 'COMPLETED' })
    const loadReport = vi.spyOn(store, 'loadReport').mockResolvedValue({ score: { overallScore: 91 } })

    const { wrapper, router } = await mountView({ phase: 'report' })
    expect(router.currentRoute.value.path).toBe('/presentation/analyzing')
    expect(wrapper.text()).toContain('발표 음성을 분석하고 있어요')
    expect(loadReport).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2_000)
    await flushPromises()

    expect(loadStatus).toHaveBeenCalledTimes(2)
    expect(loadReport).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.path).toBe('/presentation/report')
    wrapper.unmount()
  })

  test('shows guidance without offering a misleading reanalysis action when complete fails', async () => {
    const store = usePresentationStore()
    store.sessionId = 9
    store.qnaEnabled = false
    const artifacts = createArtifacts(store)
    const complete = vi.spyOn(store, 'completeSession')
      .mockRejectedValueOnce(new Error('업로드 실패'))
      .mockImplementationOnce(async () => {
        store.sessionStatus = 'completed'
      })
    vi.spyOn(store, 'loadReport').mockResolvedValue({ score: { overallScore: 80 } })
    vi.spyOn(store, 'loadReportJobStatus').mockResolvedValue({ status: 'COMPLETED' })

    const { wrapper, router } = await mountView()
    expect(wrapper.get('[role="alert"]').text()).toContain('업로드 실패')
    expect(store.recordingArtifacts.webm).toBe(artifacts.webm)
    expect(store.recordingArtifacts.wav).toBe(artifacts.wav)

    expect(wrapper.text()).toContain('새 연습을 시작해 다시 시도해주세요.')
    expect(wrapper.text()).not.toContain('다시 분석하기')
    expect(wrapper.find('[data-testid="retry-presentation-analysis"]').exists()).toBe(false)
    expect(complete).toHaveBeenCalledOnce()
    expect(router.currentRoute.value.path).toBe('/presentation/analyzing')
    wrapper.unmount()
  })

  test('shows the background-analysis notice after Spring report polling starts', async () => {
    const store = usePresentationStore()
    store.sessionId = 9
    store.sessionStatus = 'completed'
    vi.spyOn(store, 'loadReportJobStatus').mockResolvedValue({ status: 'STT_ANALYZING' })

    const { wrapper } = await mountView({ phase: 'report' })

    expect(wrapper.get('[data-testid="presentation-background-analysis-notice"]').text())
      .toContain('분석 결과를 준비하고 있어요')
    expect(wrapper.get('[data-testid="presentation-background-analysis-notice"]').text())
      .toContain('페이지를 이동해도 분석은 계속되며, 완료 후 내 기록에서 확인할 수 있습니다.')
    wrapper.unmount()
  })

  test('allows leaving without another warning after background report polling starts', async () => {
    const store = usePresentationStore()
    store.sessionId = 9
    store.sessionStatus = 'completed'
    vi.spyOn(store, 'loadReportJobStatus').mockResolvedValue({ status: 'STT_ANALYZING' })

    const { wrapper, router } = await mountView({ phase: 'report' })

    await router.push('/presentation/qna')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/presentation/qna')
    expect(wrapper.find('[data-testid="presentation-analysis-exit-dialog"]').exists()).toBe(false)

    const unload = new Event('beforeunload', { cancelable: true })
    expect(window.dispatchEvent(unload)).toBe(true)
    wrapper.unmount()
  })

  test('complete 이후 report 단계는 첫 폴링 응답 전에도 경고 없이 이탈한다', async () => {
    const store = usePresentationStore()
    store.sessionId = 9
    store.sessionStatus = 'completed'
    vi.spyOn(store, 'loadReportJobStatus').mockReturnValue(new Promise(() => {}))

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/presentation/analyzing', component: PresentationAnalyzingView },
        { path: '/presentation/qna', component: { template: '<div>qna</div>' } },
      ],
    })
    await router.push({ path: '/presentation/analyzing', query: { phase: 'report' } })
    await router.isReady()
    const wrapper = mount({
      components: { RouterView },
      template: '<RouterView />',
    }, { global: { plugins: [router] } })
    await flushPromises()

    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)

    await router.push('/presentation/qna')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/presentation/qna')
    expect(wrapper.find('[data-testid="presentation-analysis-exit-dialog"]').exists()).toBe(false)
    wrapper.unmount()
  })

  test('blocks route and browser exits while analysis is running', async () => {
    const store = usePresentationStore()
    store.sessionId = 9
    store.qnaEnabled = false
    createArtifacts(store)
    vi.spyOn(store, 'completeSession').mockReturnValue(new Promise(() => {}))

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/presentation/analyzing', component: PresentationAnalyzingView },
        { path: '/presentation/setup', component: { template: '<div>setup</div>' } },
      ],
    })
    await router.push('/presentation/analyzing')
    await router.isReady()
    const wrapper = mount({
      components: { RouterView },
      template: '<RouterView />',
    }, { global: { plugins: [router] } })
    await flushPromises()

    await router.push('/presentation/setup')
    await flushPromises()

    expect(router.currentRoute.value.path).toBe('/presentation/analyzing')
    expect(wrapper.get('[data-testid="presentation-analysis-exit-dialog"]').text())
      .toContain('분석이 진행 중입니다')

    const unload = new Event('beforeunload', { cancelable: true })
    expect(window.dispatchEvent(unload)).toBe(false)

    await wrapper.get('[data-testid="continue-presentation-analysis"]').trigger('click')
    expect(router.currentRoute.value.path).toBe('/presentation/analyzing')
    wrapper.unmount()
  })
})
