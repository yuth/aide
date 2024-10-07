/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Queue } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { themeColorFromId } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICodeEditor, isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Range } from '../../../../editor/common/core/range.js';
import { IWorkspaceTextEdit } from '../../../../editor/common/languages.js';
import { ITextModel, MinimapPosition, OverviewRulerLane, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { createTextBufferFactoryFromSnapshot, ModelDecorationOptions } from '../../../../editor/common/model/textModel.js';
import { IEditorWorkerService } from '../../../../editor/common/services/editorWorker.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { DefaultModelSHA1Computer } from '../../../../editor/common/services/modelService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IModelContentChange } from '../../../../editor/common/textModelEvents.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { minimapInlineChatDiffInserted, overviewRulerInlineChatDiffInserted } from '../../inlineChat/common/inlineChat.js';
import { IAideAgentCodeEditingService, IAideAgentCodeEditingSession } from '../common/aideAgentCodeEditingService.js';
import { HunkData, HunkDisplayData, HunkInformation, HunkState } from '../common/aideAgentEditingSession.js';
import { IAideAgentEdits, IChatTextEditGroupState } from '../common/aideAgentModel.js';



const editDecorationOptions = ModelDecorationOptions.register({
	description: 'aide-probe-edit-modified',
	className: 'inline-chat-inserted-range',
	stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
});

const editLineDecorationOptions = ModelDecorationOptions.register({
	description: 'aide-probe-edit-modified-line',
	className: 'inline-chat-inserted-range-linehighlight',
	isWholeLine: true,
	overviewRuler: {
		position: OverviewRulerLane.Full,
		color: themeColorFromId(overviewRulerInlineChatDiffInserted),
	},
	minimap: {
		position: MinimapPosition.Inline,
		color: themeColorFromId(minimapInlineChatDiffInserted),
	}
});

class AideAgentCodeEditingSession extends Disposable implements IAideAgentCodeEditingSession {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidDispose = this._register(new Emitter<void>());
	readonly onDidDispose = this._onDidDispose.event;

	private activeEditor: ICodeEditor | undefined;

	private readonly _hunkDisplayData = new Map<HunkInformation, HunkDisplayData>();
	private readonly _progressiveEditsQueue = this._register(new Queue());
	private readonly _codeEdits = new Map<string, IAideAgentEdits>();
	private readonly _workingSet = new Set<string>();

	constructor(
		readonly exchangeId: string,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorWorkerService private readonly _editorWorkerService: IEditorWorkerService,
		@IModelService private readonly _modelService: IModelService,
		@ITextModelService private readonly _textModelService: ITextModelService,
	) {
		super();

		this.registerActiveEditor();
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this.registerActiveEditor();
		}));
	}

	private registerActiveEditor() {
		const activeEditor = this.editorService.activeTextEditorControl;
		if (isCodeEditor(activeEditor)) {
			this.activeEditor = activeEditor;
			const uri = activeEditor.getModel()?.uri;
			if (uri && this._workingSet.has(uri.toString())) {
				const resourceEdits = this._codeEdits.get(uri.toString())!;
				this.updateDecorations(activeEditor, resourceEdits);
			}
		}
	}

	private updateDecorations(editor: ICodeEditor, fileEdits: IAideAgentEdits) {
		editor.changeDecorations(decorationsAccessor => {
			const keysNow = new Set(this._hunkDisplayData.keys());
			for (const hunkData of fileEdits.hunkData.getInfo()) {
				keysNow.delete(hunkData);

				const hunkRanges = hunkData.getRangesN();
				let data = this._hunkDisplayData.get(hunkData);
				if (!data) {
					const decorationIds: string[] = [];
					for (let i = 0; i < hunkRanges.length; i++) {
						decorationIds.push(decorationsAccessor.addDecoration(hunkRanges[i], i === 0
							? editLineDecorationOptions
							: editDecorationOptions
						));
					}

					const remove = () => {
						editor.changeDecorations(decorationsAccessor => {
							if (data) {
								for (const decorationId of data.decorationIds) {
									decorationsAccessor.removeDecoration(decorationId);
								}
								data.decorationIds = [];
							}
						});
					};

					data = {
						decorationIds,
						hunk: hunkData,
						position: hunkRanges[0].getStartPosition().delta(-1),
						remove
					};
					this._hunkDisplayData.set(hunkData, data);
				} else if (hunkData.getState() !== HunkState.Pending) {
					data.remove();
				} else {
					const modifiedRangeNow = hunkRanges[0];
					data.position = modifiedRangeNow.getStartPosition().delta(-1);
				}
			}

			for (const key of keysNow) {
				const data = this._hunkDisplayData.get(key);
				if (data) {
					this._hunkDisplayData.delete(key);
					data.remove();
				}
			}
		});
	}

	async apply(codeEdit: IWorkspaceTextEdit): Promise<void> {
		await this._progressiveEditsQueue.queue(async () => {
			await this.processWorkspaceEdit(codeEdit);
		});
	}

	private async processWorkspaceEdit(workspaceEdit: IWorkspaceTextEdit) {
		const resource = workspaceEdit.resource;
		const mapKey = resource.toString();

		let codeEdits: IAideAgentEdits;
		let firstEdit = false;
		if (this._codeEdits.has(mapKey)) {
			codeEdits = this._codeEdits.get(mapKey)!;
		} else {
			firstEdit = true;
			let textModel = this._modelService.getModel(resource);
			if (!textModel) {
				const ref = await this._textModelService.createModelReference(resource);
				textModel = ref.object.textEditorModel;
				ref.dispose();
			}
			const textModelN = textModel;

			const id = generateUuid();
			const textModel0 = this._register(this._modelService.createModel(
				createTextBufferFactoryFromSnapshot(textModel.createSnapshot()),
				{ languageId: textModel.getLanguageId(), onDidChange: Event.None },
				resource.with({ scheme: Schemas.vscode, authority: 'aide-agent-edits', path: '', query: new URLSearchParams({ id, 'textModel0': '' }).toString() }), true
			));

			codeEdits = {
				targetUri: resource.toString(),
				textModel0,
				textModelN,
				hunkData: this._register(new HunkData(this._editorWorkerService, textModel0, textModelN)),
			};
			this._codeEdits.set(mapKey, codeEdits);
			this._workingSet.add(resource.toString());
		}

		if (firstEdit) {
			codeEdits.textModelN.pushStackElement();
		}

		codeEdits.hunkData.ignoreTextModelNChanges = true;
		codeEdits.textModelN.pushEditOperations(null, [workspaceEdit.textEdit], () => null);
		this._register(codeEdits.textModelN.onDidChangeContent(e => {
			if (e.isUndoing) {
				this.handleUndoEditEvent(resource, e.changes);
			}
		}));
		const { editState, diff } = await this.calculateDiff(codeEdits.textModel0, codeEdits.textModelN);
		await codeEdits.hunkData.recompute(editState, diff);
		codeEdits.hunkData.ignoreTextModelNChanges = false;

		if (this.activeEditor?.getModel()?.uri.toString() === resource.toString()) {
			this.updateDecorations(this.activeEditor, codeEdits);
		}
	}

	private async calculateDiff(textModel0: ITextModel, textModelN: ITextModel) {
		const sha1 = new DefaultModelSHA1Computer();
		const textModel0Sha1 = sha1.canComputeSHA1(textModel0)
			? sha1.computeSHA1(textModel0)
			: generateUuid();
		const editState: IChatTextEditGroupState = { sha1: textModel0Sha1, applied: 0 };
		const diff = await this._editorWorkerService.computeDiff(textModel0.uri, textModelN.uri, { computeMoves: true, maxComputationTimeMs: Number.MAX_SAFE_INTEGER, ignoreTrimWhitespace: false }, 'advanced');
		return { editState, diff };
	}

	private async handleUndoEditEvent(resource: URI, changes: IModelContentChange[]) {
		const resourceEdits = this._codeEdits.get(resource.toString());
		if (!resourceEdits) {
			return;
		}

		if (!this.activeEditor || this.activeEditor.getModel()?.uri.toString() !== resource.toString()) {
			return;
		}

		this.activeEditor.changeDecorations(decorationsAccessor => {
			for (const change of changes) {
				const changeRange = change.range;
				// Remove the corresponding hunk from hunkData
				const hunkData = resourceEdits.hunkData.getInfo().find(hunk => hunk.getRangesN().some(range => range.equalsRange(changeRange)));
				if (hunkData) {
					const data = this._hunkDisplayData.get(hunkData);
					if (data) {
						this._hunkDisplayData.delete(hunkData);
						data.remove();
					}
					hunkData.discardChanges();
				}

				// Remove all decorations that intersect with the range of the change
				const intersected = this.activeEditor?.getDecorationsInRange(Range.lift(changeRange));
				for (const decoration of intersected ?? []) {
					decorationsAccessor.removeDecoration(decoration.id);
				}
			}
		});
	}

	complete(): void {
		const editedModels = new Set(Array.from(this._codeEdits.values()).map(edit => edit.textModelN));
		for (const model of editedModels) {
			model.pushStackElement();
		}
	}

	private removeDecorations() {
		for (const data of this._hunkDisplayData.values()) {
			data.remove();
		}
	}

	accept(): void {
		this.removeDecorations();
	}

	reject(): void {
		for (const edit of this._codeEdits.values()) {
			edit.hunkData.discardAll();
		}

		this.removeDecorations();
	}

	stop(): Promise<void> {
		throw new Error('Method not implemented.');
	}
}

export class AideAgentCodeEditingService extends Disposable implements IAideAgentCodeEditingService {
	_serviceBrand: undefined;

	private _sessions = new DisposableMap<string, IAideAgentCodeEditingSession>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
	}

	getOrStartCodeEditingSession(exchangeId: string): IAideAgentCodeEditingSession {
		if (this._sessions.get(exchangeId)) {
			return this._sessions.get(exchangeId)!;
		}

		const session = this.instantiationService.createInstance(AideAgentCodeEditingSession, exchangeId);
		this._sessions.set(exchangeId, session);
		return session;
	}
}