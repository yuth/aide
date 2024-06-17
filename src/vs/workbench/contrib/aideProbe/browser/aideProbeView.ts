/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from 'vs/base/browser/dom';
import { DisposableStore } from 'vs/base/common/lifecycle';
import 'vs/css!./media/aideProbe';
import 'vs/css!./media/probeBreakdownHover';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IHoverService } from 'vs/platform/hover/browser/hover';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IViewPaneOptions, ViewPane } from 'vs/workbench/browser/parts/views/viewPane';
import { IViewDescriptorService } from 'vs/workbench/common/views';
import { AideProbeInputPart } from 'vs/workbench/contrib/aideProbe/browser/aideProbeInputPart';
import { AideProbeModel } from 'vs/workbench/contrib/aideProbe/common/aideProbeModel';
import { IAideProbeService } from 'vs/workbench/contrib/aideProbe/common/aideProbeService';

const $ = dom.$;

export class AideProbeViewPane extends ViewPane {
	private container!: HTMLElement;
	private inputPart!: AideProbeInputPart;

	private readonly viewModelDisposables = this._register(new DisposableStore());
	private _viewModel: AideProbeModel | undefined;
	private set viewModel(viewModel: AideProbeModel | undefined) {
		if (this._viewModel === viewModel) {
			return;
		}

		this.viewModelDisposables.clear();

		this._viewModel = viewModel;
		if (viewModel) {
			this.viewModelDisposables.add(viewModel);
		}
	}

	get viewModel(): AideProbeModel | undefined {
		return this._viewModel;
	}

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IAideProbeService private readonly aideProbeService: IAideProbeService
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, telemetryService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.container = dom.append(container, $('.aide-probe-view'));

		this.inputPart = this._register(this.instantiationService.createInstance(AideProbeInputPart));
		this.inputPart.render(this.container, this);

		this.viewModel = this.aideProbeService.startSession();
		this.viewModelDisposables.add(this.viewModel.onDidChange(() => {
			if (!this.viewModel) {
				return;
			}

			console.log('probeView populated!');
			console.log(this.viewModel);
		}));
	}

	override focus(): void {
		super.focus();
	}

	getInput(): string {
		return this.inputPart.inputEditor.getValue();
	}

	acceptInput() {
		this._acceptInput();
	}

	private _acceptInput() {
		if (this.viewModel) {
			const editorValue = this.getInput();
			const result = this.aideProbeService.initiateProbe(this.viewModel, editorValue);

			if (result) {
				this.inputPart.acceptInput(editorValue);
				return result.responseCreatedPromise;
			}
		}

		return undefined;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		this.inputPart.layout(height, width);
	}

	override dispose(): void {
		super.dispose();
	}
}
