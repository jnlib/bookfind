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

        // ① Workers AI: 검색 키워드 + 사서 멘트
        const aiResult = await env.AI.run(AI_MODEL, {
          messages: [
            { role: 'system', content: 'JSON만 반환. 마크다운이나 설명 절대 금지. 반드시 JSON 객체만 출력해.' },
            { role: 'user', content: `사용자의 고민에 맞는 도서관 검색 키워드 5개를 만들어줘.

반드시 이 JSON 형식만 반환:
{"keywords":["키워드1","키워드2","키워드3","키워드4","키워드5"],"reply":"사서가 건네는 따뜻한 위로의 말 2문장을 직접 작성해줘"}

키워드 규칙:
- 반드시 5개
- 명사 1~2개로 구성 (예: 위로, 에세이, 한강, 자존감, 공허)
- 관련 유명 한국 작가명 1~2개 포함
- 문장 금지! "~할 때" 같은 서술형 금지

사용자: ${query}` }
          ]
        });

        const raw = typeof aiResult.response === 'string' ? aiResult.response : JSON.stringify(aiResult.response);
        const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

        const keywords = parsed.keywords || [];
        const reply = parsed.reply || '관련 책을 찾아볼게요.';

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
          if (item.exists && allBooks.length < 5) allBooks.push(item.book);
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
        const topScored = scored.slice(0, 5);

        // 결과 포맷
        const bookResults = topScored.map(function(item) {
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
        const totalCount = statusMatches.length;
        const available = availCount > 0;

        const locationMatch = html.match(/자료실\s*:\s*([^<]+)/);
        const location = locationMatch ? locationMatch[1].trim() : null;
        const detailUrl = vCtrl
          ? `${JN_BASE}/jnlib/intro/search/detail.do?vLoca=111021&vCtrl=${vCtrl}&isbn=${isbn}&menu_idx=4`
          : `${JN_BASE}/jnlib/intro/search/index.do?menu_idx=4&locExquery=111021&mainSearchType=on&search_text=${isbn}`;
        return json({ available, availCount, totalCount, location, vCtrl, detailUrl });
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

function json(data) {
  return new Response(JSON.stringify(data), { headers:{'Content-Type':'application/json',...CORS} });
}

function jsonErr(message, status) {
  return new Response(JSON.stringify({error:message}),
    {status, headers:{'Content-Type':'application/json',...CORS}});
}
