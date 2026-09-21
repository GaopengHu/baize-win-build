/**
 * 回归：模型手拼 "default_working_dir/outputs/xxx.pdf" 这类嵌套默认目录路径时，
 * 产物解析不能拼成 <cwd>/default_working_dir/outputs/...（全盘不存在），
 * 而要回收锚定到真实的 default_working_dir。
 *
 * 复现现场：cwd = C:\...\default_working_dir，
 * 模型输出 "交付文件位于 default_working_dir/outputs/xxx.pdf"，
 * 右侧产物点击"无法定位文件"，资源管理器里也没有 outputs 文件夹。
 */
import { describe, expect, it } from 'vitest';
import { resolveArtifactPath } from '../../renderer/utils/artifact-path';

const CWD = 'C:\\Users\\lenovo\\AppData\\Roaming\\今点通\\default_working_dir';

describe('resolveArtifactPath — nested default_working_dir re-anchor', () => {
  it('strips a leading default_working_dir/ segment', () => {
    const got = resolveArtifactPath('default_working_dir/outputs/录音转写字稿.pdf', CWD);
    expect(got).toBe('C:\\Users\\lenovo\\AppData\\Roaming\\今点通\\default_working_dir\\outputs\\录音转写字稿.pdf');
  });

  it('strips a fully nested <cwd>/default_working_dir/... path back to cwd', () => {
    const nested = `${CWD}\\default_working_dir\\outputs\\a.txt`;
    expect(resolveArtifactPath(nested, CWD)).toBe(`${CWD}\\outputs\\a.txt`);
  });

  it('leaves normal relative paths untouched', () => {
    expect(resolveArtifactPath('outputs/a.pdf', CWD)).toBe(`${CWD}\\outputs\\a.pdf`);
  });

  it('leaves absolute paths outside cwd untouched', () => {
    const abs = 'D:\\work\\out\\b.pdf';
    expect(resolveArtifactPath(abs, CWD)).toBe(abs);
  });

  it('does nothing when cwd is not the default dir', () => {
    const cwd = 'D:\\projects\\demo';
    const got = resolveArtifactPath('default_working_dir/outputs/a.pdf', cwd);
    expect(got).toBe('D:\\projects\\demo\\default_working_dir\\outputs\\a.pdf');
  });
});
