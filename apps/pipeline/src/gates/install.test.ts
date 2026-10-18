import { describe, expect, it } from 'vitest';
import { json, text } from '../../../../test/support/fake-fetch.js';
import { fakeHttp } from '../../../../test/support/http.js';
import { fakePackument } from '../../../../test/fixtures/sources/github.js';
import { createGithubClient } from '../sources/github.js';
import { createNpmClient } from '../sources/npm.js';
import type { RegistryPayload } from '../sources/registry.js';
import { pyprojectName, resolveInstall, sandboxShell, type InstallInputs } from './install.js';

const GH = 'https://api.github.test';
const NPM = 'https://npm.example.test';
const PYPI = 'https://pypi.example.test';

function deps(routes: Parameters<typeof fakeHttp>[0]) {
  const { http } = fakeHttp(routes);
  return {
    http,
    npm: createNpmClient(http, NPM),
    github: createGithubClient(http, 't', GH),
    pypiUrl: PYPI,
  };
}
const base: InstallInputs = {
  kind: 'mcp_server',
  sourceUrl: 'https://github.com/example-org/example-mcp',
  packageName: null,
  registry: null,
  marketplace: null,
  repoFullName: 'example-org/example-mcp',
  folder: null,
  repoVersion: 'v9.9.9',
};
const registry = (server: Record<string, unknown>): RegistryPayload => ({
  entry: { server: { name: 'test.example/x', ...server } },
  repo: null,
});

describe('resolveInstall', () => {
  it('uses the item npm package with its latest version', async () => {
    const r = await resolveInstall(
      deps({ [`${NPM}/@example%2Fmcp`]: json(fakePackument('@example/mcp')) }),
      { ...base, packageName: '@example/mcp' },
    );
    expect(r).toMatchObject({
      install: { method: 'npx', package: '@example/mcp', version: '1.0.0' },
      version: '1.0.0',
      via: 'npm package',
    });
  });

  it('falls back to Registry packages (npm, then PyPI) with env var names', async () => {
    const reg = registry({
      packages: [
        {
          registryType: 'pypi',
          identifier: 'example-mcp',
          environmentVariables: [{ name: 'EXAMPLE_KEY', isSecret: true }, { name: 'bad name' }],
        },
      ],
    });
    const r = await resolveInstall(
      deps({
        [`${PYPI}/pypi/example-mcp/json`]: json({
          info: { name: 'example-mcp', version: '0.4.1', license: 'MIT' },
        }),
      }),
      { ...base, registry: reg },
    );
    expect(r).toMatchObject({
      install: {
        method: 'uvx',
        package: 'example-mcp',
        version: '0.4.1',
        envVars: ['EXAMPLE_KEY'],
      },
      via: 'MCP Registry',
    });
  });

  it('finds Registry packages by repository URL when the item has no linked Registry record', async () => {
    const REG = 'https://registry.example.test/v0.1';
    const entry = (repoUrl: string, id: string) => ({
      server: {
        name: `test.example/${id}`,
        repository: { url: repoUrl },
        packages: [{ registryType: 'npm', identifier: id }],
      },
    });
    const d = {
      ...deps({
        [`${REG}/servers?search=example-mcp&version=latest&limit=100`]: json({
          servers: [
            entry('https://github.com/someone-else/example-mcp', 'squatter'),
            entry('https://github.com/Example-Org/example-mcp', '@example/real'),
          ],
        }),
        [`${NPM}/@example%2Freal`]: json(fakePackument('@example/real')),
      }),
      registryUrl: REG,
    };
    const r = await resolveInstall(d, base);
    expect(r.install).toMatchObject({ method: 'npx', package: '@example/real' });
  });

  it('uses a Registry remote when there is no package', async () => {
    const r = await resolveInstall(deps({}), {
      ...base,
      registry: registry({
        version: '2.0.0',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.example.test/mcp' }],
      }),
    });
    expect(r).toMatchObject({
      install: { method: 'remote', url: 'https://mcp.example.test/mcp' },
      version: '2.0.0',
    });
  });

  it('accepts a package published from the repo only if it points back at the repo', async () => {
    const pkg = {
      ...fakePackument('example-mcp', {
        repository: 'git+https://github.com/example-org/example-mcp.git',
      }),
    };
    const ok = await resolveInstall(
      deps({
        [`${GH}/repos/example-org/example-mcp/contents/package.json`]: text(
          JSON.stringify({ name: 'example-mcp' }),
        ),
        [`${NPM}/example-mcp`]: json(pkg),
      }),
      base,
    );
    expect(ok.install).toMatchObject({ method: 'npx', package: 'example-mcp' });
    const squatter = fakePackument('example-mcp', {
      repository: 'https://github.com/someone-else/other',
    });
    const bad = await resolveInstall(
      deps({
        [`${GH}/repos/example-org/example-mcp/contents/package.json`]: text(
          JSON.stringify({ name: 'example-mcp' }),
        ),
        [`${NPM}/example-mcp`]: json(squatter),
      }),
      base,
    );
    expect(bad).toMatchObject({ install: null, version: 'v9.9.9' });
  });

  it('reads pyproject.toml for Python servers', async () => {
    const r = await resolveInstall(
      deps({
        [`${GH}/repos/example-org/example-mcp/contents/pyproject.toml`]: text(
          '[build-system]\nrequires = ["x"]\n\n[project]\nname = "example-py-mcp"\nversion = "1.0"\n',
        ),
        [`${PYPI}/pypi/example-py-mcp/json`]: json({
          info: { name: 'example-py-mcp', version: '1.0.0' },
        }),
      }),
      base,
    );
    expect(r.install).toMatchObject({ method: 'uvx', package: 'example-py-mcp', version: '1.0.0' });
  });

  it('describes skills, plugins and other kinds without installing', async () => {
    expect((await resolveInstall(deps({}), { ...base, kind: 'skill' })).install).toMatchObject({
      method: 'skill_copy',
    });
    expect(
      (await resolveInstall(deps({}), { ...base, kind: 'hook_recipe' })).install,
    ).toMatchObject({ method: 'manual' });
    const marketplace = {
      marketplace: { url: 'u', name: 'example-market', fullName: 'a/b' },
      plugin: { name: 'example-plugin', source: './x' },
      resolved: null,
      repo: null,
    };
    expect(
      (await resolveInstall(deps({}), { ...base, kind: 'plugin', marketplace })).install,
    ).toMatchObject({
      method: 'plugin',
      plugin: { marketplace: 'example-market', name: 'example-plugin' },
    });
  });
});

describe('sandboxShell', () => {
  it('builds quoted commands from validated values only', () => {
    expect(
      sandboxShell({ method: 'npx', package: '@example/mcp', version: '1.2.3', envVars: [] }),
    ).toBe("exec npx -y '@example/mcp@1.2.3'");
    expect(
      sandboxShell({ method: 'uvx', package: 'example-mcp', version: '0.1.0', envVars: [] }),
    ).toContain("--from 'example-mcp==0.1.0' 'example-mcp'");
  });
  it.each([
    [
      'shell injection in name',
      { method: 'npx' as const, package: "x'; rm -rf /; '", version: '1.0.0', envVars: [] },
    ],
    [
      'injection in version',
      { method: 'npx' as const, package: 'example', version: '1.0.0 && curl x', envVars: [] },
    ],
    ['remote', { method: 'remote' as const, url: 'https://x.test', envVars: [] }],
  ])('refuses %s', (_name, install) => {
    expect(sandboxShell(install)).toBeNull();
  });
});

describe('pyprojectName', () => {
  it('reads the [project] name only', () => {
    expect(pyprojectName('[tool.poetry]\nname = "wrong"\n[project]\nname = "right"\n')).toBe(
      'right',
    );
    expect(pyprojectName('[tool.poetry]\nname = "x"\n')).toBeUndefined();
  });
});
