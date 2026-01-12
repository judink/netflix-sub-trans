# Netflix Subtitle Translator

Netflix 자막을 Gemini API로 실시간 번역하는 Chrome 확장프로그램

## 기능

- Netflix 자막 자동 감지 및 추출
- Gemini API를 이용한 고품질 번역 (문맥 기반)
- 번역된 자막을 화면 상단에 오버레이로 표시
- 번역 결과 로컬 캐싱 (재시청 시 API 호출 없음)
- 다양한 언어 지원

## 설치 방법

1. 이 저장소를 클론하거나 다운로드
2. Chrome에서 `chrome://extensions` 접속
3. "개발자 모드" 활성화
4. "압축해제된 확장 프로그램을 로드합니다" 클릭
5. 다운로드한 폴더 선택

## 설정

1. 확장프로그램 아이콘 클릭 → "설정" 버튼
2. [Google AI Studio](https://aistudio.google.com/app/apikey)에서 Gemini API 키 발급
3. API 키 입력 및 대상 언어 선택

## 사용 방법

1. Netflix에서 영상 재생
2. 확장프로그램 아이콘 클릭
3. 번역할 자막 언어 선택
4. "번역 시작" 클릭
5. 번역 완료 후 자동으로 오버레이 표시

## 지원 언어

- 소스: 한국어, 영어, 일본어, 러시아어, 스페인어, 프랑스어, 독일어, 중국어
- 대상: 우크라이나어, 한국어, 영어, 일본어, 러시아어, 스페인어, 프랑스어, 독일어, 중국어

## 기술 스택

- Chrome Extension Manifest V3
- Gemini 2.0 Flash API
- Shadow DOM (Netflix CSS 격리)

## 라이선스

MIT License
