// couple.js — "오늘의 우리": today's mood, the daily question, the shared character (명똑똑 by
// default — renamable), presence, hearts and the date badges (배지).
//
// Loaded as a plain script after app.js and studio.js and shares their globals (syncRoomId,
// getFirebaseDbUrl, partnerAName/partnerBName, escapeHtml, jsArg, showToast, db, parseAnyDate,
// coupleEventsOnDate …). app.js starts it from startCloudSyncLoop() behind a typeof guard, so the app
// keeps working if this file fails to load.
//
// Who is who: the two partners are "A" (partnerAName) and "B" (partnerBName). Each device remembers
// which one it is (aura_me_{room}); the room also keeps couple/members = { A: email, B: email }, so a
// new device or the home-screen app (which has its own storage on iPhone) recognises the signed-in
// Google account without asking again.
//
// Cloud layout (everything under aura-rooms/{room}/):
//   daily/{YYYY-MM-DD}/mood/{A|B}   = { e, t, at }   today's mood
//   daily/{YYYY-MM-DD}/answer/{A|B} = { t, c, q, at } answer: text, choice index (absent if typed)
//                                                    and the question text (since v414)
//   daily/{YYYY-MM-DD}/qi           = number         set only when someone swapped the question
//   daily/{YYYY-MM-DD}/heart/{A|B}  = ms             first heart sent that day (worth 1 point)
//   couple/members                  = { A: email, B: email }
//   couple/pet                      = { name, bornAt }
//   couple/presence/{A|B}           = ms timestamp, refreshed every minute while the app is open
//   couple/hearts/{A|B}             = { n, at }      hearts sent so far (the other side reacts)
//   couple/badges/{id}              = ms             when a badge was first earned (see COUPLE_BADGES)
//   couple/versions/{bucket|manual} = ms             change markers for together.js (버킷리스트, 사용 설명서)
// Each person only ever writes their own leaves, so two phones saving at once can't overwrite each
// other. Character points, stage and streak are never stored: they are recomputed from the history,
// so both phones always agree. Dates are the device's local calendar day.

const COUPLE_MOODS = [
    { e: "😊", n: "좋아" }, { e: "🥰", n: "설레" }, { e: "🤩", n: "신나" }, { e: "😌", n: "평온" },
    { e: "😴", n: "피곤" }, { e: "😢", n: "슬퍼" }, { e: "😤", n: "화나" }, { e: "🤒", n: "아파" }
];
const COUPLE_POLL_MS = 20000;
const COUPLE_PRESENCE_MS = 60000;
const COUPLE_ONLINE_WINDOW_MS = 150000;   // "접속 중" if the partner's heartbeat is newer than this
const COUPLE_SLEEPY_AFTER_MS = 2 * 86400000;
const COUPLE_HISTORY_DAYS = 400;
const COUPLE_DEFAULT_PET_NAME = "명똑똑";
const COUPLE_CHAR_BASE = "images/character/";

// Points → stage. Earned from the day's question (both +3, one +1), moods (both +1), each person's
// first heart of the day (+1 each), places visited after the character was born (+2) and 꾸민 사진
// saved after it (+1), and bucket-list items ticked after it (+3, together.js). Hearts beyond the
// first of the day still animate but add nothing.
const COUPLE_STAGES = [
    { min: 0, name: "알" }, { min: 5, name: "아기" }, { min: 20, name: "어린이" },
    { min: 50, name: "청소년" }, { min: 100, name: "어른" }, { min: 200, name: "전설" }
];

// 250 questions, every one answered with a tap. "질문|보기1|보기2|…" lists the choices; an
// "A vs B?" (or "A vs B, …?") question without them is a balance game with the two sides as choices.
// The first 150 must keep their text and order — days before COUPLE_Q_V2_FROM still index into
// them (see coupleQuestionIndex). Add new questions only at the end.
const COUPLE_QUESTIONS = [
    // 추억
    "우리가 처음 만난 날, 나의 첫인상은 어땠어?|첫눈에 반했어|착해 보였어|조금 무서웠어|기억이 가물가물",
    "나를 좋아한다고 처음 느낀 순간은 언제야?|처음 본 날|대화하다가|연락 기다릴 때|어느새 스며들었어",
    "지금까지 우리 데이트 중 가장 기억에 남는 날은?|첫 데이트|첫 여행|기념일 데이트|평범했던 어느 날",
    "처음 손잡았던 날 기억나? 그때 기분이 어땠어?|심장 터질 뻔|너무 설렜어|자연스러웠어|기억 안 나 😅",
    "우리 사진 중에 제일 좋아하는 한 장은?|첫 커플 사진|여행 사진|몰래 찍은 사진|웃긴 사진",
    "처음 '사랑해'라고 말했을 때 기억나?|생생하게 기억나|떨려서 기억 안 나|자연스럽게 나왔어|아직도 쑥스러워",
    "나랑 처음 먹었던 음식 기억해?|당연히 기억하지|어렴풋이 기억나|음… 힌트 줘|맛보다 너만 봤어",
    "우리가 함께 웃음이 터졌던 가장 웃긴 순간은?|길 잃었을 때|사진 찍다가|말실수했을 때|아무 이유 없이",
    "나 때문에 감동받았던 순간이 있어?|편지 받았을 때|아플 때 챙겨줘서|깜짝 선물|매일매일",
    "우리가 같이 간 곳 중 다시 가고 싶은 곳은?|첫 데이트 장소|여행지|단골 맛집|아직 고민 중",
    "사귀기 전에 나에 대해 어떻게 생각했어?|좋은 사람|궁금한 사람|친구 같은 사람|이미 좋아했어",
    "우리 연애에서 가장 설렜던 순간은?|고백한(받은) 날|첫 손잡기|첫 여행|지금 이 순간",
    "처음 우리 집 근처에 왔던 날 기억나?|생생해|어렴풋이|기억 안 나|아직 안 왔어",
    "나랑 했던 대화 중 기억에 남는 말이 있어?|사랑한다는 말|고맙다는 말|미래 얘기|웃겼던 말",
    "우리가 처음 싸웠던 날 기억나? 지금 생각하면 어때?|귀여운 추억|조금 미안해|기억 안 나|아직 안 싸웠어",
    "나에게 받은 선물 중 제일 좋았던 건?|손편지|직접 만든 것|꼭 필요했던 것|함께한 시간",
    "우리의 첫 여행(또는 첫 나들이)은 어땠어?|완벽했어|우당탕 재밌었어|설레서 정신없었어|아직 안 갔어",
    "내가 제일 귀여웠던 순간은?|잠 덜 깼을 때|밥 먹을 때|삐졌을 때|매 순간",
    "우리만 아는 웃긴 에피소드 하나만 꼽는다면?|길 잃은 날|말실수 사건|사진 사건|너무 많아서 못 골라",
    "올해 우리에게 일어난 가장 좋은 일은?|함께한 여행|기념일|서로 더 알게 된 것|그냥 우리 둘",
    // 취향
    "요즘 제일 자주 듣는 노래는?|발라드|아이돌 노래|힙합/R&B|팝송",
    "인생 영화 하나만 꼽는다면?|로맨스|액션|애니메이션|공포/스릴러",
    "평생 한 가지 음식만 먹어야 한다면?|한식|고기|면 요리|디저트",
    "가장 좋아하는 계절과 그 이유는?|🌸 봄|🌊 여름|🍁 가을|☃️ 겨울",
    "비 오는 날 하고 싶은 것은?|파전에 막걸리|집에서 영화|카페 창가|빗속 산책",
    "주말 아침에 가장 하고 싶은 것은?|늦잠|브런치|운동|같이 뒹굴기",
    "요즘 꽂힌 간식은?|과자|아이스크림|빵|과일",
    "카페에 가면 늘 시키는 메뉴는?|아메리카노|라떼|달달한 음료|차/티",
    "제일 좋아하는 색깔은?|💗 분홍|💙 파랑|💚 초록|🖤 검정/흰색",
    "가장 좋아하는 동물은?|🐶 강아지|🐱 고양이|🐰 토끼|🐼 판다",
    "하루 중 제일 좋아하는 시간대는?|아침|점심|저녁|새벽",
    "스트레스 받을 때 꼭 하는 일은?|먹기|잠자기|운동|수다 떨기",
    "요즘 갖고 싶은 물건 하나는?|옷/신발|전자기기|향수/화장품|여행 티켓",
    "어릴 때 제일 좋아했던 만화는?|짱구는 못말려|포켓몬스터|디지몬|세일러문",
    "여행 가면 꼭 하는 나만의 루틴이 있어?|맛집 검색|사진 찍기|기념품 사기|무계획이 계획",
    "가장 좋아하는 냄새는?|빵 굽는 냄새|비 냄새|섬유유연제|너의 냄새",
    "최애 편의점 조합은?|라면+김밥|컵라면+삼각김밥|도시락|과자+음료",
    "한 번쯤 배워보고 싶은 취미는?|요리|악기|운동|그림",
    "자기 전에 꼭 하는 일은?|폰 보기|너랑 연락|스트레칭|눕자마자 잠",
    "요즘 나의 최애 유튜브(또는 프로그램)는?|예능|먹방|브이로그|드라마",
    // 서로에 대해
    "내가 가장 사랑스러워 보일 때는?|웃을 때|졸릴 때|맛있게 먹을 때|집중할 때",
    "나에게 고마웠던 일 한 가지를 꼽는다면?|챙겨준 것|기다려준 것|들어준 것|웃게 해준 것",
    "내 말버릇 중에 귀여운 건?|애교 섞인 말투|감탄사|혼잣말|전부 다",
    "나랑 있을 때 가장 편한 순간은?|밥 먹을 때|산책할 때|아무것도 안 할 때|누워 있을 때",
    "내가 해주는 것 중 제일 좋아하는 건?|안아주기|챙겨주기|칭찬해주기|맛있는 거 사주기",
    "내 장점 세 가지를 말해줘!|다정+센스+유머|성실+배려+귀여움|밝음+솔직+따뜻함|다 장점이라 못 골라",
    "나를 동물에 비유하면?|🐶 강아지|🐱 고양이|🐹 햄스터|🐻 곰",
    "나를 한 단어로 표현하면?|햇살|귀요미|든든함|행복",
    "내가 몰래 해줬으면 하는 서프라이즈는?|손편지|깜짝 방문|깜짝 선물|여행 계획",
    "내가 했던 말 중에 힘이 됐던 말은?|괜찮아|잘하고 있어|내가 있잖아|사랑해",
    "나에게 배우고 싶은 점이 있다면?|긍정적인 마음|부지런함|배려심|센스",
    "내가 제일 멋있어(예뻐) 보였던 날은?|첫 데이트 날|꾸미고 온 날|기념일|매일",
    "나에 대해 아직 모르는 것 같은 게 있어?|어린 시절|진짜 속마음|숨은 취향|다 아는 것 같아",
    "내 웃음소리 어때?|귀여워|중독성 있어|시원해|따라 웃게 돼",
    "나랑 닮았다고 생각하는 점은?|입맛|웃음 코드|성격|생활 패턴",
    "나랑 다르다고 느끼는 점은?|성격|입맛|생활 패턴|연락 스타일",
    "내가 아플 때 해주고 싶은 것은?|죽 끓여주기|약 사다주기|옆에 있어주기|계속 연락하기",
    "나에게 하고 싶었는데 못 한 말이 있어?|고마워|미안해|사랑해|나중에 말할래",
    "내 사진 중에 제일 좋아하는 건?|웃는 사진|자는 사진|여행 사진|엽사",
    "나랑 연락할 때 제일 좋은 순간은?|아침 인사|잘 자 인사|갑자기 온 연락|보고 싶다는 말",
    // 미래
    "10년 후 우리는 어떤 모습일까?|지금처럼 알콩달콩|더 사랑하는 사이|베프 같은 사이|상상만 해도 좋아",
    "같이 꼭 가보고 싶은 해외 여행지는?|일본|유럽|동남아|미국",
    "언젠가 함께 살고 싶은 동네는?|도심|바닷가|숲세권|지금 이 동네",
    "우리 집에 꼭 있었으면 하는 것은?|큰 소파|넓은 주방|빔프로젝터|반려동물",
    "같이 도전해보고 싶은 것 하나는?|스카이다이빙|마라톤|요리 클래스|한 달 살기",
    "다음 기념일에 하고 싶은 데이트는?|근사한 레스토랑|여행|집에서 오붓하게|이색 체험",
    "올해가 가기 전에 함께 하고 싶은 일은?|여행|공연 보기|커플 사진 찍기|맛집 투어",
    "같이 배워보고 싶은 것이 있어?|요리|운동|외국어|악기",
    "우리만의 전통을 만든다면?|매년 같은 곳 여행|기념일 편지|한 달에 한 번 맛집|매년 커플 사진",
    "같이 키우고 싶은 반려동물이 있어?|🐶 강아지|🐱 고양이|🌱 식물|아직은 둘이 좋아",
    "나이 들어서 우리 둘이 하고 싶은 것은?|세계 여행|시골살이|작은 가게|매일 산책",
    "꿈에 그리는 이상적인 하루는?|늦잠 후 브런치|하루 종일 여행|집콕 데이트|맛집 투어",
    "같이 가고 싶은 콘서트나 공연이 있어?|아이돌 콘서트|뮤지컬|페스티벌|클래식 공연",
    "1년 뒤 오늘, 우리는 뭘 하고 있을까?|여행 중|맛있는 거 먹는 중|이 앱 하는 중|더 행복한 중",
    "버킷리스트 중 하나를 같이 한다면?|오로라 보기|크루즈 여행|번지점프|캠핑카 여행",
    "둘이 함께 이루고 싶은 목표가 있다면?|돈 모으기|건강해지기|여행 많이 다니기|매일 행복하기",
    "언젠가 우리 둘만의 가게를 연다면 무슨 가게?|카페|빵집|술집|소품샵",
    "꼭 같이 해보고 싶은 계절 데이트는?|🌸 벚꽃놀이|🌊 여름 바다|🍁 단풍 구경|⛷️ 겨울 스키",
    "같이 가보고 싶은 국내 여행지는?|제주도|강릉|부산|경주",
    "미래의 우리에게 한마디 한다면?|지금처럼만|더 사랑하자|건강하자|고마워",
    // 밸런스
    "바다 vs 산, 같이 간다면?", "평생 여름 vs 평생 겨울?", "집 데이트 vs 밖 데이트?", "아침형 vs 저녁형, 우리는?",
    "짜장면 vs 짬뽕?", "탕수육 부먹 vs 찍먹?", "민트초코 호 vs 불호?", "영화관 vs 넷플릭스?",
    "계획 여행 vs 즉흥 여행?", "카톡 길게 vs 전화 짧게?", "강아지 vs 고양이?", "놀이공원 vs 박물관?",
    "치킨 vs 피자?", "선물 받기 vs 선물 주기?", "매일 연락 vs 가끔 연락?", "단 음식 vs 짠 음식?",
    "사진 많이 찍기 vs 눈에 담기?", "기념일 크게 vs 소소하게?", "비 오는 날 vs 맑은 날?", "새벽 감성 vs 아침 감성?",
    // 귀여운 질문
    "오늘 나를 생각한 순간이 있었어? 언제?|아침에 눈 떴을 때|밥 먹을 때|자기 전|하루 종일",
    "지금 나한테 보내고 싶은 이모티콘은?|🥰|😘|🤗|🥺",
    "오늘 하루를 날씨로 표현하면?|☀️ 맑음|⛅ 구름 조금|🌧️ 비|⛈️ 천둥번개",
    "나를 위한 노래 한 곡을 추천한다면?|신나는 노래|잔잔한 발라드|달달한 사랑 노래|힘나는 응원가",
    "나한테 별명을 하나 더 지어준다면?|귀요미|애기|꿀떡이|햇살이",
    "지금 당장 같이 먹고 싶은 음식은?|🍗 치킨|🌶️ 떡볶이|🥓 삼겹살|🍣 초밥",
    "오늘 가장 잘한 일은?|일어난 것|열심히 일한 것|맛있게 먹은 것|너랑 연락한 것",
    "지금 기분을 색깔로 표현하면?|💗 분홍|💛 노랑|💙 파랑|🩶 회색",
    "나랑 바꿔서 하루를 산다면 뭐 할 거야?|나한테 연락하기|맛있는 거 먹기|푹 자기|거울 보기",
    "우리 캐릭터에게 하고 싶은 말은?|쑥쑥 자라라|귀여워|고마워|배고프지?",
    "오늘 나에게 주고 싶은 상장 이름은?|귀여움상|수고했어상|최고의 애인상|개근상",
    "지금 나한테 듣고 싶은 말은?|사랑해|보고 싶어|수고했어|맛있는 거 먹자",
    "우리 둘 사진에 제목을 붙인다면?|행복 그 자체|찰떡 커플|웃음 폭발|평생 함께",
    "오늘의 나를 칭찬해줘!|오늘도 귀여웠어|열심히 살았어|최고야|존재 자체로 칭찬해",
    "나를 과일에 비유하면?|🍓 딸기|🍑 복숭아|🍊 귤|🍉 수박",
    "지금 나를 안아줄 수 있다면 몇 초 동안?|10초|1분|1시간|안 놔줄 거야",
    "우리 사랑을 음식으로 표현하면?|달달한 케이크|매콤한 떡볶이|따끈한 국밥|톡톡 사탕",
    "오늘 하루 중 가장 행복했던 순간은?|아침|점심시간|퇴근길|바로 지금",
    "나에게 보내는 짧은 응원 한마디!|힘내!|넌 최고야|사랑해|내가 있잖아",
    "내일 나에게 해주고 싶은 것은?|모닝콜|맛있는 거 사주기|칭찬 폭격|꼭 안아주기",
    // 깊은 대화
    "요즘 가장 고민되는 것은?|일/공부|건강|돈|인간관계",
    "최근에 나를 성장시킨 경험이 있어?|일하면서|너를 만나서|새로운 도전|힘들었던 일",
    "힘들 때 내가 어떻게 해주면 좋겠어?|말없이 안아주기|얘기 들어주기|맛있는 거 사주기|혼자 있게 해주기",
    "사랑받고 있다고 느낄 때는 언제야?|챙겨줄 때|먼저 연락할 때|안아줄 때|내 얘기 기억할 때",
    "서운할 때 어떻게 말해주면 좋겠어?|바로 솔직하게|조금 지나서|글로 차분히|얼굴 보고",
    "나에게 가장 의지가 됐던 순간은?|힘든 날 곁에 있을 때|아플 때|고민 들어줄 때|항상",
    "요즘 스스로에게 해주고 싶은 말은?|수고했어|괜찮아|조금 쉬어도 돼|잘하고 있어",
    "우리가 더 잘 지내기 위해 바꾸고 싶은 한 가지는?|더 자주 표현하기|연락 습관|싸울 때 말투|지금도 충분해",
    "가장 행복했던 어린 시절 기억은?|가족 여행|친구들과 놀던 때|명절|생일 파티",
    "인생에서 가장 소중한 가치는 뭐야?|사랑|가족|건강|자유",
    "내가 너에게 어떤 사람이었으면 좋겠어?|든든한 사람|편한 사람|설레는 사람|평생 친구",
    "요즘 가장 감사한 일은?|건강한 것|너를 만난 것|가족|평범한 일상",
    "다시 태어나도 해보고 싶은 일은?|지금 하는 일|너를 만나기|세계 여행|공부",
    "나랑 있으면서 달라진 점이 있어?|더 많이 웃어|더 부지런해졌어|더 솔직해졌어|더 행복해졌어",
    "우리 관계에서 가장 자랑스러운 점은?|서로 배려하는 것|잘 웃는 것|대화가 잘 통하는 것|오래 함께한 것",
    "앞으로 우리가 꼭 지켰으면 하는 약속은?|싸워도 그날 화해|솔직하기|자주 표현하기|건강 챙기기",
    "혼자 있고 싶을 때 나는 어떻게 하면 좋을까?|조용히 기다려줘|짧게 연락만|맛있는 거 보내줘|그래도 곁에 있어줘",
    "요즘 나에게 미안했던 순간이 있어?|연락 늦었을 때|짜증 냈을 때|약속 늦었을 때|딱히 없어",
    "우리에게 '좋은 연애'란 어떤 걸까?|편안한 연애|설레는 연애|함께 성장하는 연애|웃음 많은 연애",
    "지금 이 순간 나에게 가장 하고 싶은 말은?|사랑해|보고 싶어|고마워|오늘도 수고했어",
    // 더 알아가기
    "어릴 때 꿈은 뭐였어?|선생님|연예인|의사/과학자|대통령",
    "학창 시절 별명은 뭐였어?|이름으로 만든 별명|외모 별명|성격 별명|별명 없었어",
    "나만 아는 너의 작은 습관 하나는?|머리 만지기|입술 깨물기|혼잣말|다리 떨기",
    "요즘 가장 많이 웃은 일은?|너랑 한 대화|예능/유튜브|친구들|일하다가",
    "하루가 25시간이면 남는 1시간에 뭐 할래?|잠|너랑 통화|운동|게임",
    "복권 1등 되면 제일 먼저 할 일은?|집 사기|여행 가기|가족 선물|퇴사",
    "우리 캐릭터 이름을 다시 짓는다면?|지금 이름이 최고|더 귀여운 이름|웃긴 이름|우리 이름 섞기",
    "가장 자신 있는 요리는?|라면|계란 요리|볶음밥|요리는 못해",
    "내가 몰랐을 것 같은 너의 매력은?|의외의 진지함|숨은 애교|요리 실력|운동 실력",
    "오늘 저녁 메뉴를 하나 정해준다면?|한식|중식|일식|양식",
    // ── v414: 밸런스 게임 100개 ──
    // 음식
    "떡볶이 vs 순대?", "삼겹살 vs 소고기?", "라면 vs 김밥?", "아이스 아메리카노 vs 따뜻한 라떼?",
    "케이크 vs 마카롱?", "초밥 vs 파스타?", "마라탕 vs 떡볶이?", "붕어빵 vs 호떡?",
    "아침밥 vs 늦잠 10분?", "콜라 vs 사이다?", "양념치킨 vs 후라이드?", "과자 vs 아이스크림?",
    "매운 음식 vs 순한 음식?", "편의점 야식 vs 배달 야식?", "밥 vs 빵, 아침으로?", "딸기 vs 수박?",
    "로제 떡볶이 vs 국물 떡볶이?", "맥주 vs 소주?", "뷔페 vs 오마카세?", "호텔 조식 vs 늦잠?",
    // 데이트
    "한강 피크닉 vs 루프탑 카페?", "캠핑 vs 호캉스?", "전시회 vs 방탈출?", "노래방 vs 볼링?",
    "야경 드라이브 vs 별 보기?", "쇼핑 데이트 vs 맛집 데이트?", "만화카페 vs 보드게임 카페?", "벚꽃 vs 단풍?",
    "바다 수영 vs 계곡 물놀이?", "낮 놀이공원 vs 밤 놀이공원?", "로맨스 영화 vs 공포 영화?", "집에서 요리 vs 외식?",
    "걷는 데이트 vs 앉아서 수다?", "자전거 데이트 vs 산책 데이트?", "동물원 vs 아쿠아리움?", "사진관 커플 사진 vs 셀카?",
    "공방 체험 vs 쿠킹 클래스?", "새벽 바다 vs 한밤 야경?", "페스티벌 vs 조용한 북카페?", "즉석 사진 vs 필름 카메라?",
    // 여행
    "국내 여행 vs 해외 여행?", "호텔 vs 감성 숙소?", "비행기 vs 기차?", "맛집 투어 vs 관광지 투어, 여행 가면?",
    "짐 많이 vs 짐 최소?", "일출 vs 일몰?", "도시 여행 vs 자연 여행?", "당일치기 vs 1박 2일?",
    "렌터카 vs 대중교통, 여행 가면?", "휴양 vs 관광?",
    // 연애
    "먼저 연락하기 vs 기다리기?", "서프라이즈 vs 미리 알려주기?", "싸우면 바로 화해 vs 시간 갖기?", "애교 많은 연인 vs 듬직한 연인?",
    "편지 vs 선물?", "커플템 vs 각자 스타일?", "커플링 vs 커플 팔찌?", "이모티콘 폭탄 vs 긴 문장?",
    "사진 찍어주기 vs 찍히기?", "데이트 계획 짜기 vs 따라가기?", "기념일 챙기기 vs 매일이 기념일?", "영상통화 vs 음성통화?",
    "백허그 vs 정면 포옹?", "손잡기 vs 팔짱?", "연애 공개 vs 비밀 연애?", "질투 조금 vs 질투 없음?",
    "아침 인사 vs 잘 자 인사?", "하루 종일 붙어 있기 vs 짧고 굵게?", "내가 요리 vs 네가 요리?", "깜짝 방문 vs 약속된 만남?",
    // 상상·생활
    "평생 휴대폰 없이 vs 평생 TV 없이?", "투명인간 vs 순간이동?", "과거로 가기 vs 미래로 가기?", "10억 받기 vs 10년 젊어지기?",
    "평생 라면 금지 vs 평생 치킨 금지?", "더위 vs 추위, 더 참을 수 있는 건?", "아파트 vs 주택?", "도시 생활 vs 시골 생활?",
    "알람 한 번 vs 알람 다섯 번?", "아침 샤워 vs 저녁 샤워?", "이불 밖 vs 이불 안, 주말엔?", "드라마 몰아보기 vs 하루 한 편?",
    "잔소리하는 연인 vs 무심한 연인?", "금요일 밤 vs 토요일 낮, 데이트하기 좋은 때?", "맑은 날 실내 vs 비 오는 날 야외?", "독서 vs 게임?",
    "운동하는 연인 vs 요리하는 연인?", "좋아하는 노래 반복 vs 새 노래 찾기?", "깔끔한 방 vs 자유로운 방?", "일찍 자기 vs 늦게 자기?",
    // 스타일·우리
    "짧은 머리 vs 긴 머리?", "후드티 vs 셔츠?", "운동화 vs 구두?", "향수 vs 무향?",
    "안경 vs 렌즈?", "뽀뽀 vs 포옹?", "선물 고르기 vs 갖고 싶은 거 말하기?", "매일 1분 통화 vs 주말 1시간 통화?",
    "기념일 손편지 vs 기념일 영상?", "캐릭터 밥 주기 vs 캐릭터랑 놀아주기?"
];

const couple = {
    me: null,            // "A" | "B" | null (unknown yet)
    members: {},         // { A: email, B: email }
    daily: {},           // { "2026-11-16": { mood: {...}, answer: {...}, qi } }
    pet: {},             // { name, bornAt }
    presence: {},        // { A: ms, B: ms }
    hearts: {},          // { A: {n, at}, B: {n, at} }
    versions: {},        // { bucket: ms, manual: ms } — together.js refetches when these move
    pickerOpen: false,
    answerOpen: false,
    draftMood: null,
    loadedRoom: null,
    pollId: null,
    presenceId: null,
    saving: false,
    extraPoints: 0,      // visits + creations since the character was born (recomputed on refresh)
    placeStats: null,    // all-time counts from the local DB, for badges (null until first read)
    badges: {},          // { id: ms first earned }
    metaLoaded: false,
    historyLoaded: false,
    partnerWasOnline: false
};

function coupleYmd(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function coupleAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function coupleUrl(sub) { return `${getFirebaseDbUrl()}/aura-rooms/${encodeURIComponent(syncRoomId)}/${sub}.json`; }
function coupleName(who) { return who === "A" ? partnerAName : partnerBName; }
function coupleOther(who) { return who === "A" ? "B" : "A"; }
function coupleEmail() { try { return ((firebase.auth().currentUser || {}).email || "").toLowerCase(); } catch (_) { return ""; } }
function coupleMeKey() { return `aura_me_${syncRoomId}`; }
function coupleCacheKey() { return `aura_daily_${syncRoomId}`; }
function coupleSeenKey(kind) { return `aura_couple_seen_${kind}_${syncRoomId}`; }
function couplePetName() { return (couple.pet && couple.pet.name) || COUPLE_DEFAULT_PET_NAME; }

function coupleGetSeen(kind) { try { return Number(localStorage.getItem(coupleSeenKey(kind)) || 0); } catch (_) { return 0; } }
function coupleSetSeen(kind, v) { try { localStorage.setItem(coupleSeenKey(kind), String(v)); } catch (_) { } }

function coupleSaveCache() {
    try { localStorage.setItem(coupleCacheKey(), JSON.stringify(couple.daily)); } catch (_) { }
}
function coupleLoadCache() {
    try { couple.daily = JSON.parse(localStorage.getItem(coupleCacheKey()) || "{}") || {}; } catch (_) { couple.daily = {}; }
}

async function coupleGetJson(sub, query = "") {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(coupleUrl(sub) + query, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally { clearTimeout(t); }
}
async function couplePutJson(sub, value) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    try {
        const res = await fetch(coupleUrl(sub) + "?print=silent", {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(value), signal: controller.signal
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally { clearTimeout(t); }
}

// ── Who am I ────────────────────────────────────────────────────────────────────────────────────
async function coupleResolveMe() {
    const stored = localStorage.getItem(coupleMeKey());
    if (stored === "A" || stored === "B") couple.me = stored;
    const email = coupleEmail();
    if (email) {
        const match = ["A", "B"].find(k => String(couple.members[k] || "").toLowerCase() === email);
        if (match) {
            couple.me = match;
            try { localStorage.setItem(coupleMeKey(), match); } catch (_) { }
        } else if (couple.me && !couple.members[couple.me]) {
            // Known on this device but never recorded in the room: record it so other devices learn it.
            couplePutJson(`couple/members/${couple.me}`, email).catch(() => { });
            couple.members[couple.me] = email;
        }
    }
}

window.coupleChooseMe = async function(who) {
    if (who !== "A" && who !== "B") return;
    const email = coupleEmail();
    const taken = couple.members[who];
    if (taken && email && String(taken).toLowerCase() !== email) {
        if (!confirm(`${coupleName(who)} 자리는 다른 구글 계정(${taken})으로 등록돼 있어요.\n이 계정으로 바꿀까요?`)) return;
    }
    couple.me = who;
    try { localStorage.setItem(coupleMeKey(), who); } catch (_) { }
    if (email) {
        couple.members[who] = email;
        couplePutJson(`couple/members/${who}`, email).catch(e => console.warn("[Couple] members save failed", e));
    }
    couplePresenceBeat();
    coupleRender();
};

window.coupleForgetMe = function() {
    if (!confirm("이 폰이 누구인지 다시 고를까요?")) return;
    couple.me = null;
    try { localStorage.removeItem(coupleMeKey()); } catch (_) { }
    coupleRender();
};

// ── Sync ─────────────────────────────────────────────────────────────────────────────────────────
async function coupleLoadHistory() {
    const from = coupleYmd(coupleAddDays(new Date(), -COUPLE_HISTORY_DAYS));
    const q = `?orderBy=${encodeURIComponent('"$key"')}&startAt=${encodeURIComponent(JSON.stringify(from))}`;
    const data = await coupleGetJson("daily", q);
    couple.daily = data && typeof data === "object" ? data : {};
    couple.historyLoaded = true;
    coupleSaveCache();
}

// couple/ is tiny (members, pet, presence, hearts): read it whole.
async function coupleLoadMeta() {
    const meta = (await coupleGetJson("couple")) || {};
    couple.members = meta.members || {};
    couple.pet = meta.pet || {};
    couple.presence = meta.presence || {};
    couple.hearts = meta.hearts || {};
    couple.versions = meta.versions || {};
    // Keep badges this phone just earned even if the cloud copy doesn't have them yet.
    couple.badges = Object.assign({}, couple.badges, meta.badges || {});
    couple.metaLoaded = true;
    return meta;
}

async function couplePoll() {
    const days = [coupleYmd(), coupleYmd(coupleAddDays(new Date(), -1))];
    const before = JSON.stringify([days.map(d => couple.daily[d] || null), couple.pet, couple.hearts, couple.badges]);
    const [nodes] = await Promise.all([
        Promise.all(days.map(d => coupleGetJson(`daily/${d}`).catch(() => undefined))),
        coupleLoadMeta().catch(() => null)
    ]);
    nodes.forEach((n, i) => {
        if (n === undefined) return; // network error: keep what we have
        if (n) couple.daily[days[i]] = n; else delete couple.daily[days[i]];
    });
    coupleCheckPartnerPresence();
    if (typeof togetherAfterPoll === "function") togetherAfterPoll().catch(() => { }); // together.js
    if (JSON.stringify([days.map(d => couple.daily[d] || null), couple.pet, couple.hearts, couple.badges]) !== before) {
        coupleSaveCache();
        coupleNotifyPartnerNews();
        coupleRender();
    } else {
        coupleRenderPresence();
    }
}

function couplePresenceBeat() {
    if (!couple.me || document.visibilityState !== "visible") return;
    const now = Date.now();
    couple.presence[couple.me] = now;
    couplePutJson(`couple/presence/${couple.me}`, now).catch(() => { });
}

// Called by app.js (startCloudSyncLoop) once signed in, and again after a room switch.
window.coupleStartSync = async function() {
    if (couple.pollId) clearInterval(couple.pollId);
    if (couple.presenceId) clearInterval(couple.presenceId);
    if (!syncRoomId) return;
    if (couple.loadedRoom !== syncRoomId) {
        couple.loadedRoom = syncRoomId;
        Object.assign(couple, { me: null, openState: undefined, members: {}, pet: {}, presence: {}, hearts: {}, versions: {}, badges: {}, placeStats: null, metaLoaded: false, historyLoaded: false, partnerWasOnline: false });
        coupleLoadCache();
    }
    coupleRender();
    try {
        await coupleLoadMeta();
        await coupleResolveMe();
        await coupleLoadHistory();
        await coupleEnsurePet();
    } catch (e) {
        console.warn("[Couple] initial load failed (using cache):", e);
    }
    if (typeof togetherStart === "function") await togetherStart().catch(e => console.warn("[Couple] together start failed", e)); // together.js
    await coupleRefreshExtraPoints();
    // Remember the stage we start at, so only growth that happens from now on gets celebrated.
    try {
        const k = `aura_couple_stage_${syncRoomId}`;
        if (localStorage.getItem(k) === null) localStorage.setItem(k, String(coupleStageFor(couplePoints())));
    } catch (_) { }
    coupleNotifyPartnerNews(true);
    couple.partnerWasOnline = coupleIsOnline(couple.me ? coupleOther(couple.me) : null);
    couplePresenceBeat();
    coupleRender();
    if (couple.partnerWasOnline) coupleAnimate("jump");
    couple.pollId = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        couplePoll().catch(e => console.warn("[Couple] poll failed:", e));
    }, COUPLE_POLL_MS);
    couple.presenceId = setInterval(couplePresenceBeat, COUPLE_PRESENCE_MS);
};

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && couple.pollId) {
        couplePresenceBeat();
        couplePoll().catch(() => { });
    }
});

// "New from your partner" nudges (no push notifications without a server): a toast the first time this
// device sees something the partner did since we last looked.
function coupleNotifyPartnerNews(quiet = false) {
    if (!couple.me) return;
    const other = coupleOther(couple.me), name = coupleName(other);
    const today = couple.daily[coupleYmd()] || {};
    const checks = [
        ["mood", today.mood && today.mood[other], m => `${name}가 오늘의 기분을 남겼어요 ${m.e || "💌"}`],
        ["answer", today.answer && today.answer[other], () => coupleMyAnswer() ? `${name}가 오늘의 질문에 답했어요! 💬` : `${name}가 오늘의 질문에 답했어요. 나도 답하면 볼 수 있어요 🔒`],
        ["heart", couple.hearts[other], () => `${name}가 하트를 보냈어요 💗`]
    ];
    for (const [kind, item, msg] of checks) {
        if (!item || !item.at || item.at <= coupleGetSeen(kind)) continue;
        coupleSetSeen(kind, item.at);
        if (quiet) continue;
        showToast(msg(item), "info");
        if (kind === "heart") coupleAnimate("love");
    }
}

function coupleIsOnline(who) {
    return !!who && Date.now() - (couple.presence[who] || 0) < COUPLE_ONLINE_WINDOW_MS;
}

function coupleCheckPartnerPresence() {
    if (!couple.me) return;
    const other = coupleOther(couple.me);
    const online = coupleIsOnline(other);
    if (online && !couple.partnerWasOnline) {
        showToast(`${coupleName(other)}가 들어왔어요 👋`, "info");
        coupleAnimate("jump");
    }
    couple.partnerWasOnline = online;
}

// ── Character: points, stage, state ──────────────────────────────────────────────────────────────
async function coupleEnsurePet() {
    if (couple.pet && couple.pet.bornAt) return;
    const pet = { name: (couple.pet && couple.pet.name) || COUPLE_DEFAULT_PET_NAME, bornAt: Date.now() };
    couple.pet = pet;
    await couplePutJson("couple/pet", pet);
}

async function coupleRefreshExtraPoints() {
    const born = Number(couple.pet && couple.pet.bornAt) || Date.now();
    let pts = 0;
    const st = { visits: 0, wish: 0, cafe: 0, food: 0, culture: 0, regions: 0, photos: 0, creations: 0 };
    let ok = true;
    try {
        const places = (await db.places.toArray()).filter(p => p.isDeleted !== 1);
        const visited = places.filter(p => p.isVisited === 1 || p.isVisited === true || p.isVisited === "1");
        pts += 2 * visited.filter(p => parseAnyDate(p.createdAt) >= born).length;
        st.visits = visited.length;
        st.wish = places.filter(p => p.isVisited === 0 || p.isVisited === false || p.isVisited === "0" || p.isVisited === "false").length;
        st.cafe = visited.filter(p => /cafe|카페|커피|디저트/i.test(p.category || "")).length;
        st.food = visited.filter(p => /restaurant|맛집|음식|식당/i.test(p.category || "")).length;
        st.culture = visited.filter(p => /museum|전시|미술|박물|문화|공연|영화/i.test(p.category || "")).length;
        st.regions = new Set(visited.map(p => coupleRegionOf(p.notes)).filter(Boolean)).size;
        st.photos = places.reduce((sum, p) => sum + (p.photos ? p.photos.length : (p.photo ? 1 : 0)), 0);
    } catch (_) { ok = false; }
    try {
        const rows = await db.creations.where("room").equals(syncRoomId).toArray();
        pts += rows.filter(r => (r.createdAt || 0) >= born).length;
        st.creations = rows.length;
    } catch (_) { }
    couple.extraPoints = pts;
    if (ok) couple.placeStats = st;
}

// 시/도 of an address ("대전 유성구 …" / "대전광역시 …" → "대전"), for the 여행자 badge.
const COUPLE_REGIONS = [
    ["서울", /^서울/], ["부산", /^부산/], ["대구", /^대구/], ["인천", /^인천/], ["광주", /^광주/], ["대전", /^대전/],
    ["울산", /^울산/], ["세종", /^세종/], ["경기", /^경기/], ["강원", /^강원/], ["충북", /^(충북|충청북)/],
    ["충남", /^(충남|충청남)/], ["전북", /^(전북|전라북)/], ["전남", /^(전남|전라남)/], ["경북", /^(경북|경상북)/],
    ["경남", /^(경남|경상남)/], ["제주", /^제주/]
];
function coupleRegionOf(addr) {
    const head = String(addr || "").replace(/^(주소\s*:\s*|대한민국\s+)/, "").trim();
    const hit = COUPLE_REGIONS.find(([, re]) => re.test(head));
    return hit ? hit[0] : "";
}

function coupleDayStats(day) {
    const n = couple.daily[day] || {};
    const ans = n.answer || {}, mood = n.mood || {}, heart = n.heart || {};
    return { both: !!(ans.A && ans.B), one: !!(ans.A || ans.B), moods: !!(mood.A && mood.B), hearts: (heart.A ? 1 : 0) + (heart.B ? 1 : 0) };
}

function couplePoints() {
    let pts = couple.extraPoints;
    if (typeof togetherBucketPoints === "function") pts += togetherBucketPoints(); // together.js
    for (const day of Object.keys(couple.daily)) {
        const s = coupleDayStats(day);
        pts += s.both ? 3 : s.one ? 1 : 0;
        if (s.moods) pts += 1;
        pts += s.hearts;
    }
    return pts;
}

function coupleStageFor(points) {
    let i = 0;
    COUPLE_STAGES.forEach((s, k) => { if (points >= s.min) i = k; });
    return i;
}

// Days in a row (ending today, or yesterday if today isn't done yet) on which both answered.
function coupleStreak() {
    let d = new Date();
    if (!coupleDayStats(coupleYmd(d)).both) d = coupleAddDays(d, -1);
    let n = 0;
    while (coupleDayStats(coupleYmd(d)).both) { n++; d = coupleAddDays(d, -1); }
    return n;
}

function coupleLastActivityAt() {
    let last = 0;
    for (const n of Object.values(couple.daily)) {
        for (const group of [n.mood, n.answer]) {
            if (!group) continue;
            for (const v of Object.values(group)) last = Math.max(last, (v && v.at) || 0);
        }
    }
    const other = couple.me ? coupleOther(couple.me) : null;
    if (other) last = Math.max(last, couple.presence[other] || 0);
    return last;
}

// Base mood of the character right now: anniversary > sleepy > happy > idle.
function couplePetState() {
    try { if (coupleEventsOnDate(startOfLocalDay(new Date())).length) return "bloom"; } catch (_) { }
    const last = coupleLastActivityAt();
    const h = new Date().getHours();
    if ((last && Date.now() - last > COUPLE_SLEEPY_AFTER_MS) || h < 6) return "sleepy";
    if (coupleDayStats(coupleYmd()).both) return "happy";
    return "idle";
}

// Sprite for a stage + state. Facial expressions exist only for the adult (stage 4); every stage
// from baby up has an eyes-closed frame, used for blinking and for sleeping.
function coupleSprite(stage, state, blink) {
    if (stage === 0) return `${COUPLE_CHAR_BASE}stage-0.webp`;
    if (stage === 4) {
        if (state === "sleepy") return `${COUPLE_CHAR_BASE}face-sleepy.webp`;
        if (state === "happy" || state === "love" || state === "bloom") return `${COUPLE_CHAR_BASE}face-happy.webp`;
        if (state === "sad") return `${COUPLE_CHAR_BASE}face-sad.webp`;
        return `${COUPLE_CHAR_BASE}${blink ? "face-idle-blink" : "face-idle"}.webp`;
    }
    return `${COUPLE_CHAR_BASE}stage-${stage}${blink || state === "sleepy" ? "-blink" : ""}.webp`;
}

// Preload so swapping sprites (blink, expressions) never flashes.
(function couplePreloadSprites() {
    const files = ["stage-0", "face-idle", "face-idle-blink", "face-happy", "face-sleepy", "face-sad"];
    for (let i = 1; i <= 5; i++) files.push(`stage-${i}`, `stage-${i}-blink`);
    for (let i = 0; i < 8; i++) files.push(`sticker-${i}`);
    window.addEventListener("load", () => files.forEach(f => { const im = new Image(); im.src = `${COUPLE_CHAR_BASE}${f}.webp`; }));
})();

// ── Character animation ──────────────────────────────────────────────────────────────────────────
let coupleBlinkTimer = null;
let coupleOneShotUntil = 0;

function couplePetEls() {
    return { wrap: document.getElementById("couple-pet"), img: document.getElementById("couple-pet-img"), fx: document.getElementById("couple-pet-fx") };
}

function coupleScheduleBlink() {
    clearTimeout(coupleBlinkTimer);
    coupleBlinkTimer = setTimeout(() => {
        const { img, wrap } = couplePetEls();
        const stage = Number(wrap && wrap.dataset.stage);
        const state = wrap && wrap.dataset.state;
        if (img && stage > 0 && (state === "idle" || (stage !== 4 && state !== "sleepy")) && Date.now() > coupleOneShotUntil) {
            img.src = coupleSprite(stage, state, true);
            setTimeout(() => { if (img.isConnected) img.src = coupleSprite(stage, state, false); }, 160);
        }
        coupleScheduleBlink();
    }, 2600 + Math.random() * 3200);
}

function coupleSpawn(fx, chars, count, cls) {
    if (!fx) return;
    for (let i = 0; i < count; i++) {
        const s = document.createElement("span");
        s.className = `couple-fx ${cls}`;
        s.textContent = chars[i % chars.length];
        s.style.left = `${15 + Math.random() * 70}%`;
        s.style.animationDelay = `${i * 0.12}s`;
        s.style.fontSize = `${0.9 + Math.random() * 0.7}rem`;
        fx.appendChild(s);
        setTimeout(() => s.remove(), 2600 + i * 120);
    }
}

// One-shot reactions on top of the base state: jump (partner arrived), love (heart received / tap),
// bloom (anniversary / level-up), squish (tap).
function coupleAnimate(kind) {
    const { wrap, img, fx } = couplePetEls();
    if (!wrap || !img) return;
    const stage = Number(wrap.dataset.stage);
    wrap.classList.remove("pet-jump", "pet-love", "pet-bloom-burst", "pet-squish");
    void wrap.offsetWidth; // restart the CSS animation
    coupleOneShotUntil = Date.now() + 1600;
    if (kind === "jump") {
        wrap.classList.add("pet-jump");
        coupleSpawn(fx, ["✨", "💚"], 4, "fx-pop");
    } else if (kind === "love") {
        wrap.classList.add("pet-love");
        if (stage === 4) img.src = coupleSprite(4, "love");
        coupleSpawn(fx, ["💗", "💕", "💖"], 7, "fx-float");
    } else if (kind === "bloom") {
        wrap.classList.add("pet-bloom-burst");
        coupleSpawn(fx, ["✨", "🌸", "⭐", "✨"], 8, "fx-sparkle");
    } else if (kind === "squish") {
        wrap.classList.add("pet-squish");
        coupleSpawn(fx, ["💚"], 1, "fx-float");
    }
    setTimeout(() => {
        wrap.classList.remove("pet-jump", "pet-love", "pet-bloom-burst", "pet-squish");
        if (img.isConnected) img.src = coupleSprite(stage, wrap.dataset.state, false);
    }, 1600);
}

window.couplePetTap = function() {
    const { wrap, img } = couplePetEls();
    if (!wrap) return;
    const stage = Number(wrap.dataset.stage);
    if (stage === 4 && img) {
        // The adult reacts with one of its sticker poses.
        img.src = `${COUPLE_CHAR_BASE}sticker-${Math.floor(Math.random() * 8)}.webp`;
    }
    coupleAnimate(stage === 0 ? "squish" : (Math.random() < 0.5 ? "squish" : "love"));
};

window.coupleSendHeart = async function() {
    if (!couple.me) return;
    const mine = couple.hearts[couple.me] || { n: 0 };
    const value = { n: (mine.n || 0) + 1, at: Date.now() };
    couple.hearts[couple.me] = value;
    coupleAnimate("love");
    const day = coupleYmd();
    const firstToday = !((couple.daily[day] || {}).heart || {})[couple.me];
    const before = couplePoints();
    try {
        await couplePutJson(`couple/hearts/${couple.me}`, value);
        if (firstToday) {
            await couplePutJson(`daily/${day}/heart/${couple.me}`, value.at);
            couple.daily[day] = couple.daily[day] || {};
            couple.daily[day].heart = Object.assign({}, couple.daily[day].heart, { [couple.me]: value.at });
            coupleSaveCache();
            coupleAfterPoints(before);
        } else {
            showToast("하트를 보냈어요 💗 (점수는 하루 첫 하트만 올라가요)", "info");
        }
    } catch (e) { showToast("하트를 보내지 못했어요. 인터넷 연결을 확인해 주세요.", "danger"); }
    coupleRenderPresence();
};

// After something that may have earned points: re-render, float "+N점" by the bar, celebrate a new stage.
function coupleAfterPoints(before) {
    const after = couplePoints();
    const stageBefore = coupleStageFor(before);
    coupleRender();
    if (after > before) {
        const info = document.querySelector(".couple-pet-info");
        if (info) {
            const pop = document.createElement("span");
            pop.className = "couple-pts-pop";
            pop.textContent = `+${after - before}점`;
            info.appendChild(pop);
            setTimeout(() => pop.remove(), 1800);
        }
    }
    coupleCheckLevelUp(stageBefore);
}

window.coupleRenamePet = async function() {
    const name = prompt("우리 캐릭터 이름을 지어주세요 (12자까지)", couplePetName());
    if (name === null) return;
    const clean = name.trim().slice(0, 12);
    if (!clean) return;
    couple.pet = Object.assign({}, couple.pet, { name: clean });
    try { await couplePutJson("couple/pet/name", clean); showToast(`이름을 '${clean}'(으)로 바꿨어요 💚`, "success"); }
    catch (e) { showToast("이름을 저장하지 못했어요.", "danger"); }
    coupleRender();
};

// ── Daily question ───────────────────────────────────────────────────────────────────────────────
// v414 grew the bank from 150 to 250 questions. Days before COUPLE_Q_V2_FROM keep the old 150-day
// cycle, so what was asked (and answered) on them never changes; from that day a 250-day cycle runs.
const COUPLE_Q_V1_COUNT = 150;
const COUPLE_Q_V2_FROM = "2026-11-17";

function coupleQuestionOrder(n) {
    // Fisher–Yates with a tiny seeded PRNG, so the order is the same on both phones.
    let seed = 0;
    for (const ch of String(syncRoomId)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    seed = seed || 1;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    return order;
}
let coupleQOrderCache = {};
function coupleQOrder(n) {
    const key = `${syncRoomId}/${n}`;
    return coupleQOrderCache[key] || (coupleQOrderCache[key] = coupleQuestionOrder(n));
}
function coupleDayNum(day) {
    return Math.floor(Date.UTC(...String(day).split("-").map((v, i) => i === 1 ? v - 1 : +v)) / 86400000);
}
function coupleQuestionIndex(day) {
    const n = couple.daily[day];
    if (n && Number.isInteger(n.qi) && COUPLE_QUESTIONS[n.qi]) return n.qi;
    const days = coupleDayNum(day);
    if (!Number.isFinite(days)) return coupleQOrder(COUPLE_QUESTIONS.length)[0]; // not a date key
    const from = coupleDayNum(COUPLE_Q_V2_FROM);
    const len = days < from ? COUPLE_Q_V1_COUNT : COUPLE_QUESTIONS.length;
    const k = days < from ? days : days - from;
    return coupleQOrder(len)[((k % len) + len) % len];
}
// A bank entry → { q: text, opts: [choices] }. "질문|보기1|보기2…" lists them; "A vs B?" splits in two.
function coupleQuestionAt(i) {
    const parts = String(COUPLE_QUESTIONS[i] || "").split("|");
    return { q: parts[0], opts: parts.length > 2 ? parts.slice(1) : coupleBalanceOptions(parts[0]) || [] };
}
// The question asked on a day: the text saved with the answers (since v414), else the bank entry.
function coupleQuestionOn(day) {
    const a = (couple.daily[day] || {}).answer || {};
    const saved = (a.A && a.A.q) || (a.B && a.B.q);
    return saved || coupleQuestionAt(coupleQuestionIndex(day)).q;
}
// Which choice an answer picked (-1 for a typed answer); answers before v414 carry only the text.
function coupleChoiceOf(ans, opts) {
    if (!ans || !opts) return -1;
    if (Number.isInteger(ans.c) && opts[ans.c] === ans.t) return ans.c;
    return opts.indexOf(ans.t);
}
// "바다 vs 산, 같이 간다면?" → ["바다", "산"]; null for an open question.
function coupleBalanceOptions(q) {
    const m = String(q || "").match(/^(.+?)\s+vs\s+(.+?)(?:,\s*[^,]*)?\?$/);
    return m ? [m[1].trim(), m[2].trim()] : null;
}

function coupleMyAnswer(day = coupleYmd()) {
    const n = couple.daily[day];
    return couple.me && n && n.answer ? n.answer[couple.me] || null : null;
}

window.coupleOpenAnswer = function() {
    couple.answerOpen = true;
    coupleRender();
    setTimeout(() => document.getElementById("couple-answer-text")?.focus({ preventScroll: true }), 50);
};
window.coupleCloseAnswer = function() { couple.answerOpen = false; coupleRender(); };

window.coupleSaveAnswer = async function(choice) {
    if (!couple.me || couple.saving) return;
    const day = coupleYmd();
    const { q, opts } = coupleQuestionAt(coupleQuestionIndex(day));
    let value;
    if (Number.isInteger(choice) && opts[choice] !== undefined) {
        if (coupleChoiceOf(coupleMyAnswer(day), opts) === choice) return; // tapped what I already picked
        value = { t: opts[choice], c: choice, q, at: Date.now() };
    } else {
        const text = String(document.getElementById("couple-answer-text")?.value || "").trim().slice(0, 300);
        if (!text) { showToast("답을 적어주세요", "warning"); return; }
        value = { t: text, q, at: Date.now() };
    }
    const before = couplePoints();
    couple.saving = true;
    try {
        await couplePutJson(`daily/${day}/answer/${couple.me}`, value);
        couple.daily[day] = couple.daily[day] || {};
        couple.daily[day].answer = Object.assign({}, couple.daily[day].answer, { [couple.me]: value });
        coupleSaveCache();
        couple.answerOpen = false;
        const bothNow = coupleDayStats(day).both;
        showToast(bothNow ? "둘 다 답했어요! 서로의 답을 확인해 보세요 💬" : "답을 남겼어요. 상대가 답하면 공개돼요 🔒", "success");
        coupleAfterPoints(before);
        coupleAnimate(bothNow ? "love" : "squish");
    } catch (e) {
        console.error("[Couple] answer save failed", e);
        showToast("저장하지 못했어요. 인터넷 연결을 확인해 주세요.", "danger");
    } finally {
        couple.saving = false;
    }
};

// Swap today's question (only before anyone has answered it).
window.coupleSwapQuestion = async function() {
    const day = coupleYmd();
    const n = couple.daily[day] || {};
    if (n.answer && (n.answer.A || n.answer.B)) { showToast("이미 답이 있는 질문은 바꿀 수 없어요", "warning"); return; }
    const cur = coupleQuestionIndex(day);
    let next = cur;
    while (next === cur) next = Math.floor(Math.random() * COUPLE_QUESTIONS.length);
    try {
        await couplePutJson(`daily/${day}/qi`, next);
        couple.daily[day] = Object.assign({}, n, { qi: next });
        coupleSaveCache();
        coupleRender();
    } catch (e) { showToast("질문을 바꾸지 못했어요.", "danger"); }
};

function coupleQuestionHtml() {
    const day = coupleYmd();
    const { q, opts } = coupleQuestionAt(coupleQuestionIndex(day));
    const n = couple.daily[day] || {};
    const ans = n.answer || {};
    const mine = ans[couple.me], theirs = ans[coupleOther(couple.me)];
    const other = coupleName(coupleOther(couple.me));
    let body;
    if (couple.answerOpen) {
        body = `<textarea id="couple-answer-text" rows="3" maxlength="300" placeholder="나의 답을 적어주세요">${escapeHtml(mine && coupleChoiceOf(mine, opts) < 0 ? mine.t : "")}</textarea>
            <div class="couple-mood-actions">
                <button type="button" class="btn btn-outline" onclick="coupleCloseAnswer()">취소</button>
                <button type="button" class="btn btn-primary" onclick="coupleSaveAnswer()">답하기</button>
            </div>`;
    } else {
        // One tap answers (tap another choice to change your mind). The partner's pick shows once I've
        // answered too. A typed answer ("직접 쓰기") is shown as text instead of a highlighted choice.
        const pick = coupleChoiceOf(mine, opts), theirPick = coupleChoiceOf(theirs, opts);
        const showTheirs = !!(mine && theirs);
        body = `<div class="couple-bal${opts.length > 2 ? " is-multi" : ""}">${opts.map((o, i) => `
            <button type="button" class="couple-bal-btn${pick === i ? " is-mine" : ""}${showTheirs && theirPick === i ? " is-theirs" : ""}" onclick="coupleSaveAnswer(${i})">
                <span class="couple-bal-text">${escapeHtml(o)}</span>
                <span class="couple-bal-who">${pick === i ? "나" : ""}${showTheirs && theirPick === i ? `${pick === i ? " · " : ""}${escapeHtml(other)}` : ""}</span>
            </button>`).join("")}</div>`;
        if (mine && pick < 0) body += `<div class="couple-ans is-me"><b>나</b><span>${escapeHtml(mine.t)}</span><button type="button" class="couple-link" onclick="coupleOpenAnswer()">고치기</button></div>`;
        if (showTheirs && theirPick < 0) body += `<div class="couple-ans"><b>${escapeHtml(other)}</b><span>${escapeHtml(theirs.t)}</span></div>`;
        if (showTheirs) {
            const same = pick >= 0 && pick === theirPick;
            const msg = same ? "💚 같은 답이에요! 역시 우리"
                : pick < 0 || theirPick < 0 ? "💬 서로의 답을 확인해 보세요"
                : opts.length === 2 ? "😆 서로 달라요! 오늘은 누구 취향대로?" : "💬 서로 다른 답! 왜 골랐는지 얘기해 봐요";
            body += `<div class="couple-bal-result">${msg}</div>`;
        } else if (theirs) {
            body += `<div class="couple-ans is-locked"><b>${escapeHtml(other)}</b><span>🔒 골랐어요! 나도 고르면 볼 수 있어요</span></div>`;
        } else {
            body += `<div class="couple-ans is-wait"><b>${escapeHtml(other)}</b><span>${mine ? "아직 고르지 않았어요" : "하나를 눌러서 골라주세요"}</span></div>`;
        }
        if (!mine) body += `<button type="button" class="couple-link couple-write-link" onclick="coupleOpenAnswer()">✍️ 보기에 없으면 직접 쓰기</button>`;
    }
    const canSwap = !(ans.A || ans.B);
    return `<div class="couple-q">
        <div class="couple-q-head"><span class="couple-q-label">💬 오늘의 질문</span>
            ${canSwap ? `<button type="button" class="couple-link" onclick="coupleSwapQuestion()">다른 질문</button>` : ""}</div>
        <div class="couple-q-text">${escapeHtml(q)}</div>
        ${body}
    </div>`;
}

// Past questions (newest first). The partner's answer shows only where I answered too.
window.coupleOpenArchive = function() {
    const days = Object.keys(couple.daily).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && couple.daily[d].answer).sort().reverse();
    const other = coupleOther(couple.me);
    const items = days.map(d => {
        const a = couple.daily[d].answer || {};
        const mine = a[couple.me], theirs = a[other];
        return `<div class="couple-arch-item">
            <div class="couple-arch-date">${d.replace(/-/g, ".")}</div>
            <div class="couple-q-text">${escapeHtml(coupleQuestionOn(d))}</div>
            <div class="couple-ans is-me"><b>나</b><span>${mine ? escapeHtml(mine.t) : "<i>답하지 않았어요</i>"}</span></div>
            <div class="couple-ans"><b>${escapeHtml(coupleName(other))}</b><span>${theirs ? (mine ? escapeHtml(theirs.t) : "🔒 내가 답한 날만 볼 수 있어요") : "<i>답하지 않았어요</i>"}</span></div>
        </div>`;
    }).join("") || `<div class="couple-who-hint">아직 답한 질문이 없어요. 오늘의 질문부터 시작해 보세요!</div>`;
    const body = document.getElementById("couple-archive-body");
    if (body) body.innerHTML = items;
    document.getElementById("modal-couple-archive")?.classList.add("active");
};
window.coupleCloseArchive = function() { document.getElementById("modal-couple-archive")?.classList.remove("active"); };

// ── Badges ───────────────────────────────────────────────────────────────────────────────────────
// Each badge is "stat ≥ goal" over data both phones already have (answers, moods, hearts, the
// character, places, 꾸민 사진, the D-day), so whether it's earned is recomputed, never stored. Only
// the moment it was first earned is kept, in couple/badges/{id}, written once by whichever phone
// notices first (if both race, the two timestamps are seconds apart and either is fine). An earned
// badge stays earned even if the stat later drops (e.g. a place is deleted).
const COUPLE_BADGES = [
    { id: "q1", icon: "💬", name: "첫 마음 맞추기", desc: "오늘의 질문에 처음으로 둘 다 답하기", stat: "qBoth", goal: 1 },
    { id: "q10", icon: "🗨️", name: "수다쟁이 커플", desc: "둘 다 답한 질문 10개", stat: "qBoth", goal: 10 },
    { id: "q50", icon: "📚", name: "50가지 이야기", desc: "둘 다 답한 질문 50개", stat: "qBoth", goal: 50 },
    { id: "q100", icon: "🏛️", name: "100문 100답", desc: "둘 다 답한 질문 100개", stat: "qBoth", goal: 100 },
    { id: "same10", icon: "🤝", name: "찰떡궁합", desc: "오늘의 질문에서 같은 답 10번", stat: "same", goal: 10 },
    { id: "same30", icon: "🔮", name: "텔레파시", desc: "오늘의 질문에서 같은 답 30번", stat: "same", goal: 30 },
    { id: "streak3", icon: "🔥", name: "3일 연속", desc: "3일 연속 둘 다 답하기", stat: "streak", goal: 3 },
    { id: "streak7", icon: "📅", name: "일주일 개근", desc: "7일 연속 둘 다 답하기", stat: "streak", goal: 7 },
    { id: "streak30", icon: "🏆", name: "한 달 개근", desc: "30일 연속 둘 다 답하기", stat: "streak", goal: 30 },
    { id: "mood7", icon: "🌈", name: "마음 일기", desc: "둘 다 기분을 남긴 날 7일", stat: "moods", goal: 7 },
    { id: "heart1", icon: "💗", name: "첫 하트", desc: "하트 처음 보내기", stat: "hearts", goal: 1 },
    { id: "heart100", icon: "💘", name: "하트 100개", desc: "둘이 합쳐 하트 100개 보내기", stat: "hearts", goal: 100 },
    { id: "hatch", icon: "🐣", name: "부화 성공", desc: "캐릭터가 알에서 깨어나기", stat: "stage", goal: 1 },
    { id: "teen", icon: "🌿", name: "쑥쑥 자라는 중", desc: "캐릭터가 '청소년'까지 자라기", stat: "stage", goal: 3 },
    { id: "legend", icon: "👑", name: "전설의 캐릭터", desc: "캐릭터가 '전설'이 되기", stat: "stage", goal: 5 },
    { id: "visit1", icon: "👣", name: "첫 발자국", desc: "함께 다녀온 장소 1곳", stat: "visits", goal: 1 },
    { id: "visit10", icon: "🗺️", name: "데이트 10번", desc: "함께 다녀온 장소 10곳", stat: "visits", goal: 10 },
    { id: "visit30", icon: "🧭", name: "데이트 30번", desc: "함께 다녀온 장소 30곳", stat: "visits", goal: 30 },
    { id: "visit100", icon: "🌏", name: "데이트 100번", desc: "함께 다녀온 장소 100곳", stat: "visits", goal: 100 },
    { id: "wish20", icon: "⭐", name: "꿈은 크게", desc: "위시리스트에 20곳 담기", stat: "wish", goal: 20 },
    { id: "cafe10", icon: "☕", name: "카페 탐험가", desc: "카페 10곳 다녀오기", stat: "cafe", goal: 10 },
    { id: "food10", icon: "🍜", name: "맛집 헌터", desc: "맛집 10곳 다녀오기", stat: "food", goal: 10 },
    { id: "culture5", icon: "🎨", name: "문화 데이트", desc: "전시·영화·문화 공간 5곳 다녀오기", stat: "culture", goal: 5 },
    { id: "region3", icon: "🚗", name: "여행자", desc: "3개 시·도에서 데이트하기", stat: "regions", goal: 3 },
    { id: "photo100", icon: "📸", name: "추억 수집가", desc: "장소 사진 100장 모으기", stat: "photos", goal: 100 },
    { id: "studio10", icon: "🎀", name: "꾸미기 장인", desc: "꾸민 사진 10장 만들기", stat: "creations", goal: 10 },
    { id: "d100", icon: "💯", name: "100일", desc: "사귄 지 100일", stat: "days", goal: 100 },
    { id: "d365", icon: "💍", name: "1주년", desc: "사귄 지 1년", stat: "days", goal: 365 },
    // v415 (together.js)
    { id: "bucket1", icon: "🪣", name: "첫 버킷 달성", desc: "버킷리스트 하나 이루기", stat: "bucketDone", goal: 1 },
    { id: "bucket10", icon: "🌠", name: "버킷 헌터", desc: "버킷리스트 10개 이루기", stat: "bucketDone", goal: 10 },
    { id: "bucket30", icon: "📜", name: "꿈 부자", desc: "버킷리스트에 30개 담기", stat: "bucketAll", goal: 30 },
    { id: "manual", icon: "📖", name: "서로 사용법 마스터", desc: "둘 다 사용 설명서 10칸 이상 채우기", stat: "manualBoth", goal: 1 }
];

function coupleBadgeStats() {
    let qBoth = 0, same = 0, moods = 0, streak = 0, run = 0, prev = null;
    const days = Object.keys(couple.daily).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    for (const d of days) {
        const n = couple.daily[d] || {}, st = coupleDayStats(d);
        if (st.moods) moods++;
        if (!st.both) { run = 0; prev = d; continue; }
        qBoth++;
        const a = n.answer.A, b = n.answer.B;
        if (Number.isInteger(a.c) && a.c === b.c && a.t === b.t) same++;
        run = prev && coupleDayNum(d) - coupleDayNum(prev) === 1 && run > 0 ? run + 1 : 1;
        streak = Math.max(streak, run);
        prev = d;
    }
    const hearts = ["A", "B"].reduce((sum, k) => sum + (Number(couple.hearts[k] && couple.hearts[k].n) || 0), 0);
    let dayNum = 0;
    try { dayNum = coupleDayNumber(new Date()); } catch (_) { }
    return Object.assign({ qBoth, same, streak, moods, hearts, stage: coupleStageFor(couplePoints()), days: dayNum }, couple.placeStats || {},
        typeof togetherBadgeStats === "function" ? togetherBadgeStats() : {});
}

function coupleBadgeSeenKey() { return `aura_couple_badges_seen_${syncRoomId}`; }

// Record newly earned badges and celebrate each one once per device. Runs only once the cloud copy
// of couple/ and the history are in and the local DB has been read, so nothing is mistaken as new
// (or written over an existing date) during start-up.
function coupleCheckBadges() {
    if (!couple.me || !couple.metaLoaded || !couple.historyLoaded || !couple.placeStats) return;
    const st = coupleBadgeStats();
    const now = Date.now();
    for (const b of COUPLE_BADGES) {
        if (couple.badges[b.id] || (st[b.stat] || 0) < b.goal) continue;
        couple.badges[b.id] = now;
        couplePutJson(`couple/badges/${b.id}`, now).catch(e => console.warn("[Couple] badge save failed", e));
    }
    let seen = null;
    try { seen = JSON.parse(localStorage.getItem(coupleBadgeSeenKey()) || "null"); } catch (_) { }
    const earned = COUPLE_BADGES.filter(b => couple.badges[b.id]);
    const fresh = Array.isArray(seen) ? earned.filter(b => !seen.includes(b.id)) : null;
    if (fresh && !fresh.length) return;
    try { localStorage.setItem(coupleBadgeSeenKey(), JSON.stringify(earned.map(b => b.id))); } catch (_) { }
    if (!fresh) {
        // First time on this device: no fanfare for each old badge, just one hello.
        if (earned.length) showToast(`🏅 지금까지 배지 ${earned.length}개를 모았어요! 오늘의 우리 아래 '배지'에서 볼 수 있어요`, "success");
        return;
    }
    showToast(fresh.length === 1 ? `🏅 새 배지! ${fresh[0].icon} ${fresh[0].name}` : `🏅 새 배지 ${fresh.length}개! ${fresh.map(b => b.icon).join(" ")}`, "success");
    setTimeout(() => coupleAnimate("bloom"), 500);
}

window.coupleOpenBadges = function() {
    const st = coupleBadgeStats();
    const earned = COUPLE_BADGES.filter(b => couple.badges[b.id]).length;
    const fmt = ms => { const d = new Date(ms); return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`; };
    const tiles = COUPLE_BADGES.map(b => {
        const at = couple.badges[b.id];
        const cur = Math.min(st[b.stat] || 0, b.goal);
        return `<div class="couple-badge${at ? " is-earned" : ""}">
            <div class="couple-badge-icon">${b.icon}</div>
            <div class="couple-badge-name">${escapeHtml(b.name)}</div>
            <div class="couple-badge-desc">${escapeHtml(b.desc)}</div>
            ${at ? `<div class="couple-badge-date">${fmt(at)} 획득</div>`
                 : b.goal > 1 ? `<div class="couple-badge-prog"><span style="width:${Math.round(cur / b.goal * 100)}%"></span></div><div class="couple-badge-date">${cur} / ${b.goal}</div>`
                 : `<div class="couple-badge-date">아직이에요</div>`}
        </div>`;
    }).join("");
    const body = document.getElementById("couple-badges-body");
    if (body) body.innerHTML = `<div class="couple-badge-sum">${COUPLE_BADGES.length}개 중 <b>${earned}개</b> 모았어요 🏅</div><div class="couple-badge-grid">${tiles}</div>`;
    document.getElementById("modal-couple-badges")?.classList.add("active");
};
window.coupleCloseBadges = function() { document.getElementById("modal-couple-badges")?.classList.remove("active"); };

// ── Level-up / hatch celebration ─────────────────────────────────────────────────────────────────
function coupleCheckLevelUp(stageBefore) {
    const stage = coupleStageFor(couplePoints());
    const key = `aura_couple_stage_${syncRoomId}`;
    let seen = stageBefore;
    try { seen = Math.max(stageBefore ?? 0, Number(localStorage.getItem(key) || 0)); } catch (_) { }
    try { localStorage.setItem(key, String(stage)); } catch (_) { }
    if (stage > seen) {
        const msg = stage === 1 ? `🐣 ${couplePetName()}가 알에서 깨어났어요!` : `🌱 ${couplePetName()}가 '${COUPLE_STAGES[stage].name}'(으)로 자랐어요!`;
        showToast(msg, "success");
        setTimeout(() => coupleAnimate("bloom"), 300);
    }
}

// ── Mood ─────────────────────────────────────────────────────────────────────────────────────────
window.coupleOpenMoodPicker = function() {
    const mine = coupleTodayMood(couple.me);
    couple.pickerOpen = true;
    couple.draftMood = mine ? mine.e : null;
    coupleRender();
    setTimeout(() => document.getElementById("couple-mood-text")?.focus({ preventScroll: true }), 50);
};
window.coupleCloseMoodPicker = function() { couple.pickerOpen = false; coupleRender(); };
window.coupleDraftMood = function(e) {
    couple.draftMood = e;
    document.querySelectorAll(".couple-mood-opt").forEach(b => b.classList.toggle("active", b.dataset.e === e));
};

function coupleTodayMood(who) {
    const today = couple.daily[coupleYmd()];
    return today && today.mood ? today.mood[who] || null : null;
}

window.coupleSaveMood = async function() {
    if (!couple.me || couple.saving) return;
    if (!couple.draftMood) { showToast("기분 이모지를 하나 골라주세요", "warning"); return; }
    const text = String(document.getElementById("couple-mood-text")?.value || "").trim().slice(0, 30);
    const value = { e: couple.draftMood, t: text, at: Date.now() };
    const day = coupleYmd();
    const before = couplePoints();
    couple.saving = true;
    try {
        await couplePutJson(`daily/${day}/mood/${couple.me}`, value);
        couple.daily[day] = couple.daily[day] || {};
        couple.daily[day].mood = Object.assign({}, couple.daily[day].mood, { [couple.me]: value });
        coupleSaveCache();
        couple.pickerOpen = false;
        showToast("오늘의 기분을 남겼어요 " + value.e, "success");
        couple.saving = false;
        coupleAfterPoints(before);
        return;
    } catch (e) {
        console.error("[Couple] mood save failed", e);
        showToast("저장하지 못했어요. 인터넷 연결을 확인해 주세요.", "danger");
    } finally {
        couple.saving = false;
    }
    coupleRender();
};

// ── Card ─────────────────────────────────────────────────────────────────────────────────────────
function coupleTimeLabel(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    return `${d.getHours() < 12 ? "오전" : "오후"} ${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function coupleMoodSide(who) {
    const m = coupleTodayMood(who);
    const isMe = who === couple.me;
    const name = escapeHtml(coupleName(who)) + (isMe ? " <span class=\"couple-me-tag\">나</span>" : "");
    if (!m) {
        return `<div class="couple-mood-side${isMe ? " is-me" : ""}">
            <div class="couple-mood-name">${name}</div>
            ${isMe
                ? `<button type="button" class="couple-mood-empty" onclick="coupleOpenMoodPicker()">＋<span>오늘 기분 남기기</span></button>`
                : `<div class="couple-mood-empty is-wait">💭<span>아직이에요</span></div>`}
        </div>`;
    }
    return `<div class="couple-mood-side${isMe ? " is-me" : ""}">
        <div class="couple-mood-name">${name}</div>
        <button type="button" class="couple-mood-filled" ${isMe ? `onclick="coupleOpenMoodPicker()"` : "disabled"}>
            <span class="couple-mood-emoji">${escapeHtml(m.e)}</span>
            ${m.t ? `<span class="couple-mood-text">${escapeHtml(m.t)}</span>` : ""}
            <span class="couple-mood-time">${coupleTimeLabel(m.at)}</span>
        </button>
    </div>`;
}

function coupleWeekStrip() {
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(coupleAddDays(new Date(), -i));
    const row = who => days.map(d => {
        const n = couple.daily[coupleYmd(d)];
        const m = n && n.mood && n.mood[who];
        return `<span class="couple-week-cell" title="${coupleYmd(d)}">${m ? escapeHtml(m.e) : "·"}</span>`;
    }).join("");
    const head = days.map(d => `<span class="couple-week-cell is-day">${["일", "월", "화", "수", "목", "금", "토"][d.getDay()]}</span>`).join("");
    return `<div class="couple-week">
        <div class="couple-week-row"><span class="couple-week-label"></span>${head}</div>
        <div class="couple-week-row"><span class="couple-week-label">${escapeHtml(partnerAName)}</span>${row("A")}</div>
        <div class="couple-week-row"><span class="couple-week-label">${escapeHtml(partnerBName)}</span>${row("B")}</div>
    </div>`;
}

function couplePetHtml() {
    const points = couplePoints();
    const stage = coupleStageFor(points);
    const state = couplePetState();
    const next = COUPLE_STAGES[stage + 1];
    const pct = next ? Math.round((points - COUPLE_STAGES[stage].min) / (next.min - COUPLE_STAGES[stage].min) * 100) : 100;
    const streak = coupleStreak();
    const other = coupleOther(couple.me);
    return `<div class="couple-pet-row">
        <div id="couple-pet" class="couple-pet pet-${state}${stage === 0 ? " pet-egg" : ""}" data-stage="${stage}" data-state="${state}" onclick="couplePetTap()" role="button" aria-label="${escapeHtml(couplePetName())}">
            <div id="couple-pet-fx" class="couple-pet-fx"></div>
            ${state === "sleepy" ? `<div class="couple-zz"><span>z</span><span>z</span><span>z</span></div>` : ""}
            <img id="couple-pet-img" src="${coupleSprite(stage, state, false)}" alt="" draggable="false">
        </div>
        <div class="couple-pet-info">
            <button type="button" class="couple-pet-name" onclick="coupleRenamePet()" title="이름 바꾸기">${escapeHtml(couplePetName())} <span>✏️</span></button>
            <div class="couple-pet-stage">${COUPLE_STAGES[stage].name}${next ? ` · 다음 '${next.name}'까지 ${next.min - points}점` : " · 최고 단계!"}</div>
            <div class="couple-pet-bar"><span style="width:${pct}%"></span></div>
            <div class="couple-pet-meta">${streak > 0 ? `<span>🔥 ${streak}일 연속</span>` : ""}<span id="couple-presence">${coupleIsOnline(other) ? `🟢 ${escapeHtml(coupleName(other))} 접속 중` : ""}</span></div>
            <button type="button" class="couple-heart-btn" onclick="coupleSendHeart()">💗 하트 보내기</button>
        </div>
    </div>`;
}

// ── Open / close: the "명똑똑 키우기" button on the D-day card ─────────────────────────────────────
// Closed by default; each device remembers its choice. While closed, a dot on the button says there's
// something to do or see (my question/mood for today, or something the partner did since the card was
// last open). With no anniversary set there's no D-day card to hold the button, so the card stays open.
function coupleOpenKey() { return `aura_couple_open_${syncRoomId}`; }
function coupleLookedKey() { return `aura_couple_looked_${syncRoomId}`; }
function coupleIsOpen() {
    if (!document.getElementById("couple-toggle-slot")) return true;
    if (couple.openState === undefined) {
        try { couple.openState = localStorage.getItem(coupleOpenKey()) === "1"; } catch (_) { couple.openState = false; }
    }
    return couple.openState;
}
function coupleNeedsLook() {
    if (!couple.me) return true;
    const day = coupleYmd();
    if (!coupleMyAnswer(day) || !coupleTodayMood(couple.me)) return true;
    let looked = 0;
    try { looked = Number(localStorage.getItem(coupleLookedKey()) || 0); } catch (_) { }
    const other = coupleOther(couple.me), n = couple.daily[day] || {};
    return [n.answer && n.answer[other], n.mood && n.mood[other], couple.hearts[other]].some(x => x && (x.at || 0) > looked);
}
// Called by coupleRender() and by app.js's renderDdayCard() (which may run before or after it).
window.coupleApplyOpen = function() {
    const card = document.getElementById("couple-card");
    const slot = document.getElementById("couple-toggle-slot");
    const open = coupleIsOpen();
    if (card && syncRoomId) card.classList.toggle("hidden", !open);
    if (open && slot) { try { localStorage.setItem(coupleLookedKey(), String(Date.now())); } catch (_) { } }
    if (slot && syncRoomId) {
        const dot = !open && coupleNeedsLook();
        slot.innerHTML = `<button type="button" class="couple-toggle-btn${open ? " is-open" : ""}" onclick="coupleToggleCard()" aria-expanded="${open}">🌱 ${escapeHtml(couplePetName())} 키우기${dot ? `<i class="couple-toggle-dot" aria-label="새 소식"></i>` : ""}<span class="couple-toggle-chev">${open ? "▴" : "▾"}</span></button>`;
    } else if (slot) slot.innerHTML = "";
};
window.coupleToggleCard = function() {
    couple.openState = !coupleIsOpen();
    try { localStorage.setItem(coupleOpenKey(), couple.openState ? "1" : "0"); } catch (_) { }
    coupleApplyOpen();
    if (couple.openState) {
        setTimeout(() => document.getElementById("couple-card")?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
    }
};

function coupleRenderPresence() {
    const el = document.getElementById("couple-presence");
    if (!el || !couple.me) return;
    const other = coupleOther(couple.me);
    el.textContent = coupleIsOnline(other) ? `🟢 ${coupleName(other)} 접속 중` : "";
}

function coupleRender() {
    const card = document.getElementById("couple-card");
    if (!card) return;
    if (!syncRoomId) { card.classList.add("hidden"); coupleApplyOpen(); return; }
    coupleApplyOpen();
    const now = new Date();
    const title = `<div class="couple-head"><span class="couple-title">🌤️ 오늘의 우리</span>
        <span class="couple-date">${now.getMonth() + 1}월 ${now.getDate()}일 ${["일", "월", "화", "수", "목", "금", "토"][now.getDay()]}요일</span></div>`;

    if (!couple.me) {
        card.innerHTML = `${title}
            <div class="couple-who">
                <div class="couple-who-q">이 폰을 쓰는 사람은 누구예요? 🙋</div>
                <div class="couple-who-btns">
                    <button type="button" class="btn btn-outline" onclick="coupleChooseMe('A')">${escapeHtml(partnerAName)}</button>
                    <button type="button" class="btn btn-outline" onclick="coupleChooseMe('B')">${escapeHtml(partnerBName)}</button>
                </div>
                <div class="couple-who-hint">한 번만 고르면 돼요. 같은 구글 계정이면 다른 기기에서도 자동으로 알아봐요.</div>
            </div>`;
        return;
    }

    let picker = "";
    if (couple.pickerOpen) {
        const mine = coupleTodayMood(couple.me);
        picker = `<div class="couple-mood-picker">
            <div class="couple-mood-opts">${COUPLE_MOODS.map(m => `<button type="button" class="couple-mood-opt${couple.draftMood === m.e ? " active" : ""}" data-e="${m.e}" onclick="coupleDraftMood(${jsArg(m.e)})"><span>${m.e}</span><small>${m.n}</small></button>`).join("")}</div>
            <input type="text" id="couple-mood-text" maxlength="30" placeholder="한마디 남기기 (선택, 30자)" value="${escapeHtml(mine && mine.t || "")}">
            <div class="couple-mood-actions">
                <button type="button" class="btn btn-outline" onclick="coupleCloseMoodPicker()">취소</button>
                <button type="button" class="btn btn-primary" onclick="coupleSaveMood()">남기기</button>
            </div>
        </div>`;
    }

    coupleCheckBadges();
    const badgeCount = COUPLE_BADGES.filter(b => couple.badges[b.id]).length;
    card.innerHTML = `${title}
        ${couplePetHtml()}
        ${coupleQuestionHtml()}
        <div class="couple-moods">${coupleMoodSide(couple.me)}${coupleMoodSide(coupleOther(couple.me))}</div>
        ${picker}
        ${coupleWeekStrip()}
        <div class="couple-foot">
            <button type="button" class="couple-link" onclick="coupleOpenArchive()">📖 지난 질문</button>
            <button type="button" class="couple-link" onclick="coupleOpenBadges()">🏅 배지 ${badgeCount}/${COUPLE_BADGES.length}</button>
            <button type="button" class="couple-link" onclick="coupleForgetMe()">이 폰: ${escapeHtml(coupleName(couple.me))} · 바꾸기</button>
        </div>`;
    coupleScheduleBlink();
    const state = couplePetState();
    const key = `aura_couple_bloom_${syncRoomId}`;
    if (state === "bloom" && (() => { try { return localStorage.getItem(key) !== coupleYmd(); } catch (_) { return true; } })()) {
        // Anniversary: bloom once per day when the card is first shown.
        try { localStorage.setItem(key, coupleYmd()); } catch (_) { }
        setTimeout(() => coupleAnimate("bloom"), 400);
    }
}

// Visits / 꾸민 사진 change the points: refresh them now and then (cheap, local DB only).
setInterval(() => {
    if (!couple.pollId || document.visibilityState !== "visible") return;
    const before = JSON.stringify([couple.extraPoints, couple.placeStats]);
    coupleRefreshExtraPoints().then(() => { if (JSON.stringify([couple.extraPoints, couple.placeStats]) !== before) coupleRender(); });
}, 60000);

// The date rolls over at midnight while the app may stay open: re-render when the day changes.
let coupleRenderedDay = coupleYmd();
setInterval(() => {
    if (coupleYmd() !== coupleRenderedDay) { coupleRenderedDay = coupleYmd(); coupleRender(); }
}, 60000);
