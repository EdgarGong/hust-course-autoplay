(() => {
  'use strict';

  const url = new URL(location.href);
  const course = url.searchParams.get('courseId');
  if (url.pathname !== '/mooc-smartcourse/mycourse/studentstudy' || !course) return;

  const key = `hust-course-autoplay:${course}`;
  const videoSelector = 'iframe.ans-insertvideo-online[src*="/ananas/modules/video/index.html"]';
  const workSelector = 'iframe[src*="/ananas/modules/work/index.html"]';
  const unfinished = '.ans-job-icon[aria-label="任务点未完成"]';
  const observed = new WeakSet();
  let end;
  let nextVideo;
  let checkPlayback;
  const autoplayBlocked = '浏览器限制有声自动播放，请在播放器内点一次播放';

  function getState() {
    try {
      return JSON.parse(sessionStorage.getItem(key)) || {};
    } catch {
      return {};
    }
  }

  const state = getState();
  const badge = document.createElement('button');
  badge.id = 'hust-course-autoplay-toggle';
  badge.type = 'button';
  document.body.append(badge);

  function status(message) {
    badge.setAttribute('aria-pressed', String(Boolean(state.enabled)));
    badge.textContent = message || (state.enabled ? '连播已开启' : '开启连播');
    badge.title = state.enabled ? '点击关闭华科智课连播' : '在此标签页开启华科智课连播';
  }

  function save() {
    sessionStorage.setItem(key, JSON.stringify(state));
  }

  function isChapterQuiz(frame) {
    const quiz = frame?.contentDocument?.querySelector('iframe#frame_content')?.contentDocument;
    return Boolean(quiz?.querySelector('#RightCon[aria-label="章节测验"]'));
  }

  function isQuizTask(marker) {
    return isChapterQuiz(marker.parentElement.querySelector(workSelector));
  }

  function openNext(chapter, now, deferredQuiz) {
    const next = document.querySelector('#prevNextFocusNext');
    if (!next?.getClientRects().length || next.getAttribute('aria-disabled') === 'true' ||
        !next.textContent.includes('下一节')) {
      delete state.pending;
      save();
      status('没有可用的下一节');
      return;
    }
    state.pending = { from: chapter, deadline: now + 35000, confirmQuiz: deferredQuiz };
    save();
    status(deferredQuiz ? '测验留待作答，正在打开下一节…' : '正在打开下一节…');
    next.click();
  }

  function confirmQuizNavigation(card, now) {
    const dialog = document.querySelector('.jobFinishTip');
    const next = dialog?.querySelector('a.nextChapter');
    if (!next?.getClientRects().length || next.textContent.trim() !== '下一节' ||
        !dialog.textContent.includes('当前章节还有任务点未完成')) return;

    const tasks = [...card.querySelectorAll(unfinished)];
    if (!tasks.every(isQuizTask)) return;

    state.pending.confirmQuiz = false;
    state.pending.deadline = now + 35000;
    save();
    next.click();
  }

  function applyPlaybackSpeed(video) {
    if (!state.enabled) return;
    if (video.defaultPlaybackRate !== 2) video.defaultPlaybackRate = 2;
    if (video.playbackRate !== 2) video.playbackRate = 2;
  }

  function play(frame) {
    const player = frame?.contentDocument;
    const video = player?.querySelector('video.vjs-tech');
    if (!video) return false;
    applyPlaybackSpeed(video);
    if (!video.paused && video.readyState >= 2) {
      checkPlayback = undefined;
      status();
      return true;
    }
    if (video.ended) return false;

    const now = Date.now();
    if (checkPlayback?.video !== video) checkPlayback = { video, nextTry: 0 };
    const attempt = checkPlayback;
    if (attempt.blocked || now < attempt.nextTry || (attempt.waiting && now < attempt.deadline)) return false;

    attempt.nextTry = now + 1500;
    attempt.deadline = now + 4000;
    attempt.waiting = true;
    status('正在开始播放…');
    const failed = error => {
      if (!state.enabled || checkPlayback !== attempt || !frame.isConnected) return;
      attempt.waiting = false;
      attempt.blocked = error?.name === 'NotAllowedError';
      status(attempt.blocked ? autoplayBlocked : '播放器加载中，正在重试…');
    };
    try {
      // The platform button may initialize a lazy-loaded source. Click only once:
      // a second click on a toggle control could pause playback that just started.
      if (!attempt.buttonClicked) {
        const button = [...player.querySelectorAll('button.vjs-big-play-button, button.vjs-play-control')]
          .find(control => control.getClientRects().length && !control.disabled);
        if (button) {
          attempt.buttonClicked = true;
          button.click();
        }
      }
      const request = video.play();
      if (request?.then) request.then(() => { attempt.waiting = false; }, failed);
      else attempt.waiting = false;
    } catch (error) {
      failed(error);
    }
    // Keep the navigation/retry state until a later tick observes actual playback.
    return false;
  }

  function tick() {
    const card = document.querySelector('iframe#iframe')?.contentDocument;
    const chapter = card && new URL(card.URL).searchParams.get('knowledgeid');
    const frames = chapter ? [...card.querySelectorAll(videoSelector)] : [];
    const now = Date.now();

    for (const frame of frames) {
      const video = frame.contentDocument?.querySelector('video.vjs-tech');
      if (!video || observed.has(video)) continue;
      observed.add(video);
      applyPlaybackSpeed(video);
      video.addEventListener('loadedmetadata', () => applyPlaybackSpeed(video));
      video.addEventListener('playing', () => applyPlaybackSpeed(video));
      video.addEventListener('ended', event => {
        if (!state.enabled || !event.isTrusted || !video.ended || !frame.isConnected) return;
        end = { card, frame, video, earliest: Date.now() + 2000, deadline: Date.now() + 15000 };
        status('视频播完，等待平台确认…');
      });
    }

    if (!state.enabled) return;

    if (state.pending) {
      const expired = now >= state.pending.deadline;
      const arrived = chapter && chapter !== state.pending.from;
      if (expired || (arrived && play(frames[0]))) {
        delete state.pending;
        save();
        if (expired) status(checkPlayback?.blocked ? autoplayBlocked : '续播已停，请查看当前章节');
      } else if (arrived && !frames.length) {
        const attachments = [...card.querySelectorAll('#pageDiv .ans-attach-ct > iframe')];
        if (attachments.length && attachments.every(frame => frame.matches(workSelector) && isChapterQuiz(frame)) &&
            [...card.querySelectorAll(unfinished)].every(isQuizTask)) {
          openNext(chapter, now, true);
          return;
        }
      } else if (chapter === state.pending.from && state.pending.confirmQuiz) {
        confirmQuizNavigation(card, now);
      }
    }

    if (nextVideo && (nextVideo.card !== card || play(nextVideo.frame) || now >= nextVideo.deadline)) {
      if (now >= nextVideo.deadline) status(checkPlayback?.blocked ? autoplayBlocked : '请手动点播放');
      nextVideo = undefined;
    }

    if (!end || now < end.earliest) return;
    if (end.card !== card || !frames.includes(end.frame) || !end.video.ended) {
      end = undefined;
      return;
    }

    const following = frames[frames.indexOf(end.frame) + 1];
    const nextContainer = following?.closest('.videoContainer');
    const pendingTasks = [...card.querySelectorAll(unfinished)];
    const blockingTasks = pendingTasks.filter(marker => !isQuizTask(marker));
    const blocked = blockingTasks.some(marker => !following || (!nextContainer?.contains(marker) &&
      Boolean(marker.compareDocumentPosition(following) & Node.DOCUMENT_POSITION_FOLLOWING)));
    if (blocked && now < end.deadline) return;
    end = undefined;
    if (blocked) {
      status('续播已停，本节有未完成任务');
      return;
    }

    if (following) {
      nextVideo = { card, frame: following, deadline: now + 20000 };
      return;
    }

    openNext(chapter, now, blockingTasks.length < pendingTasks.length);
  }

  badge.addEventListener('click', () => {
    state.enabled = !state.enabled;
    delete state.pending;
    end = nextVideo = checkPlayback = undefined;
    save();
    status();
    if (state.enabled) {
      const card = document.querySelector('iframe#iframe')?.contentDocument;
      const frame = card?.querySelectorAll(videoSelector)[0];
      if (frame) {
        nextVideo = { card, frame, deadline: Date.now() + 20000 };
        play(frame);
      }
    }
  });

  status();
  setInterval(tick, 400);
  tick();
})();
