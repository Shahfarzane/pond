#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#include <sddl.h>
#else
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>
#endif

/** Same framing as Chrome native messaging: 32-bit little-endian length, then UTF-8 JSON. */
#define MAX_MSG (8u * 1024u * 1024u)
/** Chrome closes the port when the host sends more than 1 MiB, so cap below it. */
#define MAX_RESPONSE (1024u * 1024u - 4096u)

static const char *offline_json = "{\"ok\":false,\"error\":\"offline\"}";
static const char *too_large_json = "{\"ok\":false,\"error\":\"too_large\"}";
static const char *queued_json = "{\"ok\":true,\"data\":{\"queued\":true}}";

static int read_full(
#ifdef _WIN32
    HANDLE fd,
#else
    int fd,
#endif
    void *buf, size_t n) {
  unsigned char *p = buf;
  size_t got = 0;
  while (got < n) {
#ifdef _WIN32
    DWORD chunk = 0;
    DWORD remaining = (DWORD)(n - got);
    if (!ReadFile(fd, p + got, remaining, &chunk, NULL) || chunk == 0) return -1;
    got += (size_t)chunk;
#else
    ssize_t r = read(fd, p + got, n - got);
    if (r == 0) return -1;
    if (r < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    got += (size_t)r;
#endif
  }
  return 0;
}

static int write_full(
#ifdef _WIN32
    HANDLE fd,
#else
    int fd,
#endif
    const void *buf, size_t n) {
  const unsigned char *p = buf;
  size_t put = 0;
  while (put < n) {
#ifdef _WIN32
    DWORD chunk = 0;
    DWORD remaining = (DWORD)(n - put);
    if (!WriteFile(fd, p + put, remaining, &chunk, NULL) || chunk == 0) return -1;
    put += (size_t)chunk;
#else
    ssize_t w = write(fd, p + put, n - put);
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    put += (size_t)w;
#endif
  }
  return 0;
}

#ifdef _WIN32
static int current_user_pipe_path(char *pipe_path, size_t capacity) {
  HANDLE token = NULL;
  DWORD size = 0;
  TOKEN_USER *user = NULL;
  LPSTR sid = NULL;
  int result = -1;

  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return -1;
  (void)GetTokenInformation(token, TokenUser, NULL, 0, &size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) goto done;
  user = malloc(size);
  if (!user) goto done;
  if (!GetTokenInformation(token, TokenUser, user, size, &size)) goto done;
  if (!ConvertSidToStringSidA(user->User.Sid, &sid)) goto done;

  int n = snprintf(
      pipe_path,
      capacity,
      "\\\\.\\pipe\\pond-native-host-%s",
      sid);
  if (n >= 0 && (size_t)n < capacity) result = 0;

done:
  if (sid) LocalFree(sid);
  free(user);
  if (token) CloseHandle(token);
  return result;
}

static HANDLE connect_to_pond(void) {
  char pipe_path[256];
  if (current_user_pipe_path(pipe_path, sizeof pipe_path) != 0) {
    return INVALID_HANDLE_VALUE;
  }
  for (int attempt = 0; attempt < 2; attempt++) {
    HANDLE pipe = CreateFileA(
        pipe_path,
        GENERIC_READ | GENERIC_WRITE,
        0,
        NULL,
        OPEN_EXISTING,
        0,
        NULL);
    if (pipe != INVALID_HANDLE_VALUE) return pipe;
    if (GetLastError() != ERROR_PIPE_BUSY || !WaitNamedPipeA(pipe_path, 2000)) {
      break;
    }
  }
  return INVALID_HANDLE_VALUE;
}
#endif

static int write_reply(const void *body, uint32_t len) {
  if (fwrite(&len, 4, 1, stdout) != 1) return -1;
  if (fwrite(body, 1, len, stdout) != len) return -1;
  return fflush(stdout) == 0 ? 0 : -1;
}

static void reply_json(const char *json) {
  (void)write_reply(json, (uint32_t)strlen(json));
}

static void reply_offline(void) {
  reply_json(offline_json);
}

/** Discards an oversize request so the browser's write does not fail mid-message. */
static void drain_stdin(uint32_t n) {
  unsigned char scratch[4096];
  while (n > 0) {
    size_t want = n < sizeof scratch ? n : sizeof scratch;
    size_t got = fread(scratch, 1, want, stdin);
    if (got == 0) return;
    n -= (uint32_t)got;
  }
}

/*
 * Offline inbox. When Pond is closed, a save (`enqueue` or `capture.accept`) is written
 * to the inbox as one JSON file and Pond dispatches it at launch
 * (`src/main/native/offline-inbox.ts`). Every other request still answers `offline`.
 *
 * The host does not decode JSON. It walks the top-level members of the request object,
 * which is enough to read `type` and drop `cookies`, so session cookies never reach the
 * disk. A request it cannot walk, or one with an escaped key, is not queued.
 */

static size_t skip_ws(const unsigned char *s, size_t n, size_t i) {
  while (i < n && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
  return i;
}

/** Moves *i past the string that opens at s[*i]. */
static int skip_string(const unsigned char *s, size_t n, size_t *i) {
  size_t j = *i + 1;
  while (j < n) {
    if (s[j] == '\\') {
      j += 2;
      continue;
    }
    if (s[j] == '"') {
      *i = j + 1;
      return 0;
    }
    j++;
  }
  return -1;
}

/** Moves *i past one value: a string, a nested object or array, or a bare literal. */
static int skip_value(const unsigned char *s, size_t n, size_t *i) {
  size_t j = *i;
  if (j >= n) return -1;
  if (s[j] == '"') return skip_string(s, n, i);
  if (s[j] == '{' || s[j] == '[') {
    size_t depth = 0;
    while (j < n) {
      if (s[j] == '"') {
        if (skip_string(s, n, &j) != 0) return -1;
        continue;
      }
      if (s[j] == '{' || s[j] == '[') depth++;
      if (s[j] == '}' || s[j] == ']') {
        if (--depth == 0) {
          *i = j + 1;
          return 0;
        }
      }
      j++;
    }
    return -1;
  }
  while (j < n && s[j] != ',' && s[j] != '}' && s[j] != ']' && s[j] != ' ' &&
         s[j] != '\t' && s[j] != '\n' && s[j] != '\r') {
    j++;
  }
  if (j == *i) return -1;
  *i = j;
  return 0;
}

static int span_is(const unsigned char *s, size_t start, size_t end, const char *text) {
  size_t len = strlen(text);
  return end - start == len && memcmp(s + start, text, len) == 0;
}

/**
 * Copies a save request into out without its `cookies` member. Returns the length
 * written, or 0 when the request is not a save. out must hold len + 1 bytes.
 */
static size_t queued_body(const unsigned char *req, size_t len, unsigned char *out) {
  size_t i = skip_ws(req, len, 0);
  if (i >= len || req[i] != '{') return 0;
  i = skip_ws(req, len, i + 1);
  if (i < len && req[i] == '}') return 0;

  size_t o = 0;
  int save = 0;
  out[o++] = '{';
  for (;;) {
    if (i >= len || req[i] != '"') return 0;
    size_t key = i;
    if (skip_string(req, len, &i) != 0) return 0;
    size_t key_end = i;
    if (memchr(req + key, '\\', key_end - key)) return 0;
    i = skip_ws(req, len, i);
    if (i >= len || req[i] != ':') return 0;
    size_t value = skip_ws(req, len, i + 1);
    i = value;
    if (skip_value(req, len, &i) != 0) return 0;
    size_t value_end = i;

    if (span_is(req, key, key_end, "\"type\"")) {
      save = span_is(req, value, value_end, "\"enqueue\"") ||
             span_is(req, value, value_end, "\"capture.accept\"");
    }
    if (!span_is(req, key, key_end, "\"cookies\"")) {
      if (o > 1) out[o++] = ',';
      memcpy(out + o, req + key, key_end - key);
      o += key_end - key;
      out[o++] = ':';
      memcpy(out + o, req + value, value_end - value);
      o += value_end - value;
    }

    i = skip_ws(req, len, i);
    if (i < len && req[i] == ',') {
      i = skip_ws(req, len, i + 1);
      continue;
    }
    if (i < len && req[i] == '}') break;
    return 0;
  }
  if (skip_ws(req, len, i + 1) != len || !save) return 0;
  out[o++] = '}';
  return o;
}

/** Keep in lockstep with `nativeInboxPath` in `src/main/native/paths.ts`. */
static int inbox_dir(char *out, size_t capacity) {
#ifdef _WIN32
  const char *base = getenv("APPDATA");
  const char *format = "%s\\Pond\\Inbox";
#else
  const char *base = getenv("HOME");
  const char *format = "%s/Library/Application Support/Pond/Inbox";
#endif
  if (!base || !base[0]) return -1;
  int n = snprintf(out, capacity, format, base);
  return n >= 0 && (size_t)n < capacity ? 0 : -1;
}

/** Milliseconds since 1970, so file names sort in the order the saves were made. */
static unsigned long long now_ms(void) {
#ifdef _WIN32
  FILETIME ft;
  ULARGE_INTEGER t;
  GetSystemTimeAsFileTime(&ft);
  t.LowPart = ft.dwLowDateTime;
  t.HighPart = ft.dwHighDateTime;
  return (t.QuadPart - 116444736000000000ULL) / 10000ULL;
#else
  struct timeval tv;
  gettimeofday(&tv, NULL);
  return (unsigned long long)tv.tv_sec * 1000ULL + (unsigned long long)tv.tv_usec / 1000ULL;
#endif
}

/** Writes a hidden temp file, then renames it, so Pond never reads half a save. */
static int write_inbox(const char *dir, const unsigned char *body, size_t len) {
  char temp[640];
  char final[640];
  unsigned long long ms = now_ms();
#ifdef _WIN32
  unsigned long pid = (unsigned long)GetCurrentProcessId();
  const char *sep = "\\";
#else
  unsigned long pid = (unsigned long)getpid();
  const char *sep = "/";
#endif
  int t = snprintf(temp, sizeof temp, "%s%s.%013llu-%lu.tmp", dir, sep, ms, pid);
  int f = snprintf(final, sizeof final, "%s%s%013llu-%lu.json", dir, sep, ms, pid);
  if (t < 0 || (size_t)t >= sizeof temp || f < 0 || (size_t)f >= sizeof final) return -1;

#ifdef _WIN32
  if (!CreateDirectoryA(dir, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) return -1;
  HANDLE file = CreateFileA(
      temp, GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (file == INVALID_HANDLE_VALUE) return -1;
  int written = write_full(file, body, len) == 0 && FlushFileBuffers(file);
  CloseHandle(file);
  if (!written || !MoveFileExA(temp, final, MOVEFILE_WRITE_THROUGH)) {
    DeleteFileA(temp);
    return -1;
  }
#else
  if (mkdir(dir, 0700) != 0 && errno != EEXIST) return -1;
  int fd = open(temp, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return -1;
  int written = write_full(fd, body, len) == 0 && fsync(fd) == 0;
  if (close(fd) != 0) written = 0;
  if (!written || rename(temp, final) != 0) {
    unlink(temp);
    return -1;
  }
#endif
  return 0;
}

static int queue_request(const unsigned char *req, uint32_t len) {
  char dir[512];
  if (inbox_dir(dir, sizeof dir) != 0) return -1;
  unsigned char *body = malloc((size_t)len + 1);
  if (!body) return -1;
  size_t body_len = queued_body(req, len, body);
  int result = body_len > 0 ? write_inbox(dir, body, body_len) : -1;
  free(body);
  return result;
}

/** Pond is not listening: a save waits in the inbox, anything else reports offline. */
static void reply_closed(const unsigned char *req, uint32_t len) {
  if (queue_request(req, len) == 0) {
    reply_json(queued_json);
  } else {
    reply_offline();
  }
}

int main(void) {
#ifdef _WIN32
  (void)_setmode(_fileno(stdin), _O_BINARY);
  (void)_setmode(_fileno(stdout), _O_BINARY);
#else
  const char *home = getenv("HOME");
  if (!home || !home[0]) {
    fprintf(stderr, "pond-native-host: HOME is unset\n");
    reply_offline();
    return 0;
  }

  char sock_path[512];
  int n = snprintf(
      sock_path,
      sizeof sock_path,
      "%s/Library/Application Support/Pond/native.sock",
      home);
  if (n < 0 || (size_t)n >= sizeof sock_path) {
    reply_offline();
    return 0;
  }
#endif

  uint32_t req_len = 0;
  if (fread(&req_len, 4, 1, stdin) != 1) {
    return 0;
  }
  if (req_len == 0 || req_len > MAX_MSG) {
    fprintf(stderr, "pond-native-host: request too large (%u)\n", req_len);
    reply_json(too_large_json);
    drain_stdin(req_len);
    return 0;
  }

  unsigned char *req = malloc(req_len);
  if (!req) {
    reply_offline();
    return 0;
  }
  if (fread(req, 1, req_len, stdin) != req_len) {
    free(req);
    reply_offline();
    return 0;
  }

#ifdef _WIN32
  HANDLE fd = connect_to_pond();
  if (fd == INVALID_HANDLE_VALUE) {
    reply_closed(req, req_len);
    free(req);
    return 0;
  }
#else
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) {
    free(req);
    reply_offline();
    return 0;
  }

  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  strncpy(addr.sun_path, sock_path, sizeof addr.sun_path - 1);

  if (connect(fd, (struct sockaddr *)&addr, sizeof addr) != 0) {
    close(fd);
    reply_closed(req, req_len);
    free(req);
    return 0;
  }
#endif

  if (write_full(fd, &req_len, 4) != 0 || write_full(fd, req, req_len) != 0) {
#ifdef _WIN32
    CloseHandle(fd);
#else
    close(fd);
#endif
    free(req);
    reply_offline();
    return 0;
  }
  free(req);

  uint32_t res_len = 0;
  if (read_full(fd, &res_len, 4) != 0 || res_len == 0 || res_len > MAX_MSG) {
#ifdef _WIN32
    CloseHandle(fd);
#else
    close(fd);
#endif
    reply_offline();
    return 0;
  }
  if (res_len > MAX_RESPONSE) {
#ifdef _WIN32
    CloseHandle(fd);
#else
    close(fd);
#endif
    reply_json(too_large_json);
    return 0;
  }

  unsigned char *res = malloc(res_len);
  if (!res) {
#ifdef _WIN32
    CloseHandle(fd);
#else
    close(fd);
#endif
    reply_offline();
    return 0;
  }
  if (read_full(fd, res, res_len) != 0) {
    free(res);
#ifdef _WIN32
    CloseHandle(fd);
#else
    close(fd);
#endif
    reply_offline();
    return 0;
  }
#ifdef _WIN32
  CloseHandle(fd);
#else
  close(fd);
#endif

  int written = write_reply(res, res_len);
  free(res);
  if (written != 0) {
    fprintf(stderr, "pond-native-host: failed to write response\n");
    return 1;
  }
  return 0;
}
