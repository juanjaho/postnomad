const fs = require('fs');
const path = require('path');
const { _internal } = require('./trust-install');
const { shellEscape, stageCa, cleanupStaged } = _internal;

describe('trust-install helpers', () => {
  it('shell-escapes single quotes via POSIX-safe quoting', () => {
    expect(shellEscape('hello')).toBe("'hello'");
    expect(shellEscape("it's")).toBe("'it'\\''s'");
    expect(shellEscape('/path with spaces/ca.crt')).toBe("'/path with spaces/ca.crt'");
    expect(shellEscape('path;rm -rf /')).toBe("'path;rm -rf /'");
  });

  it('stageCa copies the cert into a fresh per-call directory', () => {
    const src = path.join(__dirname, 'trust-install.fixture.crt');
    fs.writeFileSync(src, 'fake cert content');
    try {
      const staged = stageCa(src);
      expect(fs.existsSync(staged.dir)).toBe(true);
      expect(fs.existsSync(staged.path)).toBe(true);
      expect(fs.readFileSync(staged.path, 'utf8')).toBe('fake cert content');

      // Two calls produce different directories.
      const staged2 = stageCa(src);
      expect(staged2.dir).not.toBe(staged.dir);

      cleanupStaged(staged);
      cleanupStaged(staged2);
      expect(fs.existsSync(staged.dir)).toBe(false);
      expect(fs.existsSync(staged2.dir)).toBe(false);
    } finally {
      fs.unlinkSync(src);
    }
  });

  it('cleanupStaged is safe to call twice / on missing dir', () => {
    expect(() => cleanupStaged(null)).not.toThrow();
    expect(() => cleanupStaged({ dir: '/nonexistent/postnomad-test-xyz' })).not.toThrow();
  });
});
