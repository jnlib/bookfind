const LIB_KEY    = '07f4b234a27b4e8d0bbaef41e070810c1f626991298cd1c5798356b2ca8ff62b';
const LIB_BASE   = 'https://data4library.kr/api';
const LIB_CODE   = '111021';
const JN_BASE    = 'https://jnlib.sen.go.kr';
const AI_MODEL   = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);

    // ── /recommend ── Workers AI → 정보나루 검색 → 점수 정렬 ──
    if (url.pathname === '/recommend' && request.method === 'POST') {
      try {
        const { query } = await request.json();

        // ① Workers AI: 검색 키워드 + 공감 멘트
        const aiResult = await env.AI.run(AI_MODEL, {
          messages: [
            { role: 'system', content: 'JSON만 반환. 마크다운이나 설명 절대 금지. 반드시 JSON 객체만 출력해.' },
            { role: 'user', content: `당신은 도서관의 따뜻한 AI 사서예요. 사용자의 고민을 듣고 공감해주고, 도서관 검색 키워드를 만들어주세요.

반드시 이 JSON 형식만 반환:
{"keywords":["키워드1","키워드2","키워드3","키워드4","키워드5"],"reply":"공감 멘트"}

reply 규칙:
- 반드시 해요체 (~에요, ~해요, ~있어요, ~드릴게요)
- 사용자의 감정에 먼저 공감하고, 책을 찾아보겠다는 말로 마무리
- 2~3문장, 따뜻하고 다정하게
- 예시: "많이 지치셨을 것 같아요. 그런 마음이 들 때 위로가 되어줄 책이 분명 있을 거예요. 제가 찾아볼게요."

키워드 규칙:
- 반드시 5개
- 명사 1~2개로 구성 (예: 위로, 에세이, 철학, 자존감, 공허)
- 작가명은 최대 1개만 포함, 나머지는 주제어/장르어로
- 다양한 장르가 나오도록 (에세이, 소설, 심리, 시 등 섞기)
- 문장 금지! "~할 때" 같은 서술형 금지

사용자: ${query}` }
          ]
        });

        const raw = typeof aiResult.response === 'string' ? aiResult.response : JSON.stringify(aiResult.response);
        const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

        const keywords = parsed.keywords || [];
        const reply = cleanKorean(parsed.reply || '관련 책을 찾아볼게요.');

        // ② 정보나루 API: 키워드별 검색
        const allBooks = [];
        const seenIsbns = new Set();

        const searchPromises = keywords.map(function(kw) {
          const qs = new URLSearchParams({
            authKey: LIB_KEY, format: 'json',
            keyword: kw, pageSize: '10'
          });
          return fetch(`${LIB_BASE}/srchBooks?${qs}`)
            .then(r => r.json())
            .then(d => {
              let docs = d.response?.docs ?? [];
              if (!Array.isArray(docs)) docs = [docs];
              return docs.map(i => i.doc ?? i).filter(b => b.bookname && (b.isbn13 || b.isbn));
            })
            .catch(() => []);
        });

        const results = await Promise.all(searchPromises);

        // 중복 제거 + 수집
        const candidates = [];
        for (const books of results) {
          for (const b of books) {
            const isbn = b.isbn13 || b.isbn || '';
            if (!isbn || seenIsbns.has(isbn)) continue;
            seenIsbns.add(isbn);
            candidates.push(b);
          }
        }

        // 키워드 매칭 점수로 사전 정렬
        const preSorted = candidates.map(function(b) {
          let s = 0;
          const t = (b.bookname || '').toLowerCase();
          const a = (b.authors || '').toLowerCase();
          keywords.forEach(kw => { if (t.includes(kw.toLowerCase())) s += 15; if (a.includes(kw.toLowerCase())) s += 8; });
          if (parseInt(b.loan_count) > 50) s += 5;
          else if (parseInt(b.loan_count) > 10) s += 2;
          return { book: b, ps: s };
        });
        preSorted.sort((a, b) => b.ps - a.ps);

        // bookExist API로 종로도서관 소장 확인
        const top = preSorted.slice(0, 15);
        const existResults = await Promise.all(top.map(item => {
          const isbn = item.book.isbn13 || item.book.isbn;
          return fetch(`${LIB_BASE}/bookExist?authKey=${LIB_KEY}&format=json&isbn13=${isbn}&libCode=${LIB_CODE}`)
            .then(r => r.json())
            .then(d => ({ book: item.book, exists: d.response?.result?.hasBook === 'Y' }))
            .catch(() => ({ book: item.book, exists: false }));
        }));
        for (const item of existResults) {
          if (item.exists && allBooks.length < 3) allBooks.push(item.book);
        }

        if (allBooks.length === 0) {
          return json({ reply, books: [], message: '도서관에서 관련 책을 찾지 못했어요.' });
        }

        // ③ 점수 계산
        const scored = allBooks.map(function(b) {
          let score = 0;
          const title = (b.bookname || '').toLowerCase();
          const author = (b.authors || '').toLowerCase();
          const desc = (b.description || '').toLowerCase();

          keywords.forEach(function(kw) {
            const kwl = kw.toLowerCase();
            if (title.includes(kwl)) score += 15;
            if (author.includes(kwl)) score += 8;
            if (desc.includes(kwl)) score += 5;
          });

          const loans = parseInt(b.loan_count) || 0;
          if (loans > 100) score += 8;
          else if (loans > 50) score += 5;
          else if (loans > 20) score += 3;
          else if (loans > 5) score += 1;

          return { book: b, score };
        });

        scored.sort((a, b) => b.score - a.score);
        const topScored = scored.slice(0, 3);

        // ④ Workers AI 2차: 각 책별 추천 멘트 생성
        const bookList = topScored.map((item, i) =>
          `${i+1}. 「${item.book.bookname}」 - ${item.book.authors || '저자 미상'}`
        ).join('\n');

        let comments = [];
        try {
          const commentResult = await env.AI.run(AI_MODEL, {
            messages: [
              { role: 'system', content: 'JSON 배열만 반환. 마크다운이나 설명 절대 금지. 반드시 한국어만 사용. 중국어/일본어/영어 단어 절대 금지.' },
              { role: 'user', content: `당신은 도서관의 따뜻한 AI 사서예요.

사용자의 고민: "${query}"

아래 책들을 이 사용자에게 왜 추천하는지, 각 책마다 1~2문장으로 추천 멘트를 써주세요.

${bookList}

규칙:
- 반드시 해요체 (~에요, ~해요, ~있어요, ~거예요)
- 반드시 한국어만 사용 (일본어, 영어 절대 금지)
- "사용자"라는 단어 금지, 자연스럽게 말하기
- 책의 내용과 고민을 연결해서 왜 이 책이 도움이 되는지 설명
- 따뜻하고 다정한 톤, 각 1~2문장
- 예시: "일상 속 작은 변화가 얼마나 큰 힘을 가지는지 알려주는 책이에요. 지친 마음에 다시 시작할 용기를 줄 거예요."

반드시 이 JSON 형식만 반환 (책 수만큼):
["1번 책 멘트","2번 책 멘트","3번 책 멘트"]` }
            ]
          });
          const commentRaw = typeof commentResult.response === 'string' ? commentResult.response : JSON.stringify(commentResult.response);
          comments = JSON.parse(commentRaw.replace(/```json|```/g, '').trim()).map(cleanKorean);
        } catch(e) { /* 멘트 실패해도 책 결과는 반환 */ }

        // 결과 포맷
        const bookResults = topScored.map(function(item, i) {
          const isbn = item.book.isbn13 || item.book.isbn;
          return {
            bookname: item.book.bookname,
            authors: item.book.authors,
            publisher: item.book.publisher,
            publication_year: item.book.publication_year,
            isbn13: isbn,
            bookImageURL: item.book.bookImageURL,
            loan_count: item.book.loan_count,
            detailUrl: `${JN_BASE}/jnlib/intro/search/index.do?menu_idx=4&locExquery=111021&mainSearchType=on&search_text=${isbn}`,
            comment: comments[i] || '',
            score: item.score
          };
        });

        return json({ reply, books: bookResults });

      } catch(e) { return jsonErr(e.message, 500); }
    }

    // ── /library ──
    if (url.pathname === '/library') {
      try {
        const params = new URLSearchParams(url.search);
        const endpoint = params.get('_endpoint');
        params.delete('_endpoint');
        params.set('authKey', LIB_KEY);
        params.set('format', 'json');
        if (!params.has('libCode')) params.set('libCode', LIB_CODE);
        const allowed = ['srchBooks','bookExist','srchLibs'];
        if (!allowed.includes(endpoint)) return jsonErr('허용되지 않은 endpoint', 400);
        const r = await fetch(`${LIB_BASE}/${endpoint}?${params}`);
        const d = await r.json();
        return new Response(JSON.stringify(d), { headers:{'Content-Type':'application/json',...CORS} });
      } catch(e) { return jsonErr(e.message, 500); }
    }

    // ── /realcheck ── 종로도서관 홈페이지 크롤링 ──
    if (url.pathname === '/realcheck') {
      const isbn = url.searchParams.get('isbn');
      if (!isbn) return jsonErr('isbn 파라미터 필요', 400);
      try {
        const searchUrl = `${JN_BASE}/jnlib/intro/search/index.do?menu_idx=4&locExquery=111021&editMode=normal&mainSearchType=on&search_text=${isbn}`;
        const r = await fetch(searchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'ko-KR,ko;q=0.9',
          }
        });
        const html = await r.text();
        const vCtrlMatch = html.match(/vCtrl="(\d+)"/);
        const vCtrl = vCtrlMatch ? vCtrlMatch[1] : null;

        // 자료상태 필드에서 실제 대출 상태 파싱
        const statusMatches = [...html.matchAll(/자료상태\s*:[\s\S]*?(대출가능|대출중|대출불가)/g)];
        const availCount = statusMatches.filter(m => m[1] === '대출가능').length;
        const loanCount = statusMatches.filter(m => m[1] === '대출중').length;
        const totalCount = statusMatches.length;
        const available = availCount > 0;
        // 상태 텍스트
        let status = '미소장';
        if (totalCount > 0) {
          if (availCount > 0) status = '대출가능';
          else if (loanCount > 0) status = '전권 대출중';
          else status = '대출불가';
        }

        const locationMatch = html.match(/자료실\s*:\s*([^<]+)/);
        const location = locationMatch ? locationMatch[1].trim() : null;
        const detailUrl = vCtrl
          ? `${JN_BASE}/jnlib/intro/search/detail.do?vLoca=111021&vCtrl=${vCtrl}&isbn=${isbn}&menu_idx=4`
          : `${JN_BASE}/jnlib/intro/search/index.do?menu_idx=4&locExquery=111021&mainSearchType=on&search_text=${isbn}`;
        return json({ status, available, availCount, loanCount, totalCount, location, vCtrl, detailUrl });
      } catch(e) { return jsonErr(e.message, 500); }
    }

    // ── /libcode ──
    if (url.pathname === '/libcode') {
      return json({libCode:LIB_CODE,libName:'종로도서관'});
    }

    if (url.pathname==='/'||url.pathname==='/health')
      return json({status:'ok'});

    return jsonErr('Not Found', 404);
  }
};

// 비한국어 문자(중국어/일본어) 및 깨진 텍스트 제거
function cleanKorean(text) {
  if (!text) return text;
  return text
    .replace(/[\u4E00-\u9FFF\u3400-\u4DBF]+/g, '')  // 한자(중국어)
    .replace(/[\u3040-\u309F\u30A0-\u30FF]+/g, '')   // 히라가나/카타카나
    .replace(/[.:]{3,}/g, '')                         // 깨진 반복 문자
    .replace(/\s{2,}/g, ' ')                          // 다중 공백 정리
    .trim();
}

function json(data) {
  return new Response(JSON.stringify(data), { headers:{'Content-Type':'application/json',...CORS} });
}

function jsonErr(message, status) {
  return new Response(JSON.stringify({error:message}),
    {status, headers:{'Content-Type':'application/json',...CORS}});
}
