import { SHADER_TRANSITIONS, glTransitionUrl } from './transitions/catalog';
import { EFFECTS } from './effects/catalog';

/**
 * Whose work the transitions and effects are, and under what terms, for the
 * Licenses dialog. Both licences used ask for their notice to travel with
 * every copy, the binary included; here it is, word for word.
 *
 * Sources checked file by file (gl-transitions at commit bec402c, 2026-10):
 * each shader's own header names its author and licence. Left out of the
 * library on licence grounds: anything taken from Shadertoy (usually CC
 * BY-NC-SA, which forbids commercial use) - burn0 and perlin borrow noise
 * from one; tangentMotionBlur, ported from a blog post with no licence;
 * GlitchMemories, "based on work from natewave" with no source; and lygia's
 * functions, under its own Prosperity licence. Nothing from a commercial
 * editor's assets is used.
 */

export const GL_TRANSITIONS_URL = 'https://github.com/gl-transitions/gl-transitions';
export const GLFX_URL = 'https://github.com/evanw/glfx.js';

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export const GL_TRANSITIONS_MIT = `MIT License

Copyright (c) 2017-present gl-transitions contributors

${MIT_BODY}`;

export const GLFX_MIT = `Copyright (C) 2011 by Evan Wallace

${MIT_BODY}`;

export const PAGE_CURL_BSD = `Copyright (c) 2010 Hewlett-Packard Development Company, L.P. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
     notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
     copyright notice, this list of conditions and the following disclaimer
     in the documentation and/or other materials provided with the
     distribution.
   * Neither the name of Hewlett-Packard nor the names of its
     contributors may be used to endorse or promote products derived from
     this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

export interface Credit {
  id: string;
  author: string;
  licence: string;
  url: string;
}

export const TRANSITION_CREDITS: readonly Credit[] = SHADER_TRANSITIONS.map((entry) => ({
  id: entry.id,
  author: entry.author,
  licence: entry.licence === 'MIT' ? 'MIT' : 'BSD 3-Clause',
  url: glTransitionUrl(entry.file),
}));

export const EFFECT_CREDITS: readonly Credit[] = EFFECTS.map((effect) => ({
  id: effect.type,
  author: effect.origin === 'glfx' ? 'Evan Wallace (glfx.js)' : '',
  licence: effect.origin === 'glfx' ? 'MIT' : '',
  url: effect.origin === 'glfx' ? GLFX_URL : '',
}));
